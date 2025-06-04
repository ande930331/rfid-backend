const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const port = process.env.PORT || 3000;

const axios = require('axios');

require('dotenv').config();

const LINE_TOKEN = process.env.LINE_TOKEN;
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});


db.connect(err => {
  if (err) throw err;
  console.log('✅ MySQL Connected');
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// ✅ 首頁轉址
app.get('/', (req, res) => {
  res.redirect('/index.html');
});
// 發送 LINE 訊息（單人）
async function sendLineAlert(message) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/push', {
      to: '你的LINE使用者ID', // ← 可透過 webhook 或 QRCode 掃描來取得（後面補充）
      messages: [{ type: 'text', text: message }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_TOKEN}`
      }
    });
    console.log('✅ LINE 警告訊息已發送');
  } catch (error) {
    console.error('❌ 發送 LINE 失敗:', error.response?.data || error.message);
  }
}
// ✅ ESP32 上傳資料（加上 WebSocket 廣播）
app.post('/upload', (req, res) => {
  const {
    value1: uid,
    value2: direction,
    value3: deviceName,
    value4: deviceTime,
  } = req.body;

  if (!uid || !direction || !deviceName || !deviceTime) {
    return res.status(400).send("Missing parameters");
  }

  // 檢查 UID 是否授權
  const checkSql = 'SELECT * FROM authorized_uids WHERE uid = ?';
  db.query(checkSql, [uid], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: '授權查詢失敗' });

    const isAuthorized = results.length > 0 ? 1 : 0;
    const username = results.length > 0 ? results[0].username : null;

    // ✅ 一律記錄（授權 or 未授權）
    const insertSql = `
      INSERT INTO access_logs (uid, direction, device_name, device_time, authorized)
      VALUES (?, ?, ?, ?, ?)
    `;
    db.query(insertSql, [uid, direction, deviceName, deviceTime, isAuthorized], (err2) => {
      if (err2) return res.status(500).json({ success: false, message: '紀錄寫入失敗' });

      // ✅ 成功後進行 WebSocket 廣播
      const newRecord = {
        uid,
        direction,
        deviceName,
        deviceTime,
        authorized: isAuthorized,
        username: username || '未知',
      };
      broadcast(JSON.stringify({ type: 'new_log', data: newRecord }));

      if (isAuthorized) {
        console.log('✅ 授權通過 UID:', uid);
        res.json({ success: true, authorized: true, user: username });
      } else {
        console.log('⚠️ 未授權 UID:', uid);
        res.json({ success: true, authorized: false });
      }
      if (!isAuthorized) {
  const lineMessage = `🚨 非授權 RFID 刷卡警告！
UID: ${uid}
方向: ${direction}
時間: ${deviceTime}
設備: ${deviceName}`;
  sendLineAlert(lineMessage);
}

    });
  });
});




// ✅ API - 最新紀錄
app.get('/api/logs', (req, res) => {
  const sql = 'SELECT * FROM access_logs ORDER BY id DESC LIMIT 100';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
});

// ✅ API - 統計資料
app.get('/api/stats', (req, res) => {
  const { date, start, end } = req.query;

  if (date) {
    // 單日比例圖
    const sql = `
      SELECT direction, COUNT(*) AS count
      FROM access_logs
      WHERE DATE(server_time) = ?
      GROUP BY direction
    `;
    db.query(sql, [date], (err, results) => {
      if (err) return res.status(500).json({ error: 'Stats query error' });

      const stat = { IN: 0, OUT: 0 };
      results.forEach(row => {
        stat[row.direction] = row.count;
      });

      res.json(stat);
    });

  } else if (start && end) {
    // 區間折線圖
    const sql = `
      SELECT DATE(server_time) AS date, direction, COUNT(*) AS count
      FROM access_logs
      WHERE DATE(server_time) BETWEEN ? AND ?
      GROUP BY DATE(server_time), direction
      ORDER BY DATE(server_time)
    `;

    db.query(sql, [start, end], (err, results) => {
      if (err) return res.status(500).json({ error: 'Stats range query error' });

      const statsMap = {};
      results.forEach(row => {
        const dateStr = new Date(row.date).toISOString().split('T')[0]; // 強制格式
        if (!statsMap[dateStr]) {
          statsMap[dateStr] = { date: dateStr, IN: 0, OUT: 0 };
        }
        statsMap[dateStr][row.direction] = row.count;
      });

      const sortedStats = Object.values(statsMap).sort(
        (a, b) => new Date(a.date) - new Date(b.date)
      );

      res.json(sortedStats);
    });

  } else {
    res.status(400).json({ error: '缺少查詢參數（date 或 start/end）' });
  }
});

// ✅ WebSocket 廣播
function broadcast(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ✅ 啟動伺服器
server.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
