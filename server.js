const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize SQLite database
const db = new Database(process.env.DATABASE_PATH || 'donations.db');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS donations (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    message TEXT,
    timestamp TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    delivered INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS top_spenders (
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    total_amount INTEGER NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_delivered ON donations(delivered);
  CREATE INDEX IF NOT EXISTS idx_received_at ON donations(received_at);
`);

// Prepared statements
const insertDonation = db.prepare(`
  INSERT INTO donations (id, username, display_name, amount, message, timestamp, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const updateTopSpender = db.prepare(`
  INSERT INTO top_spenders (username, display_name, total_amount)
  VALUES (?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET
    total_amount = total_amount + excluded.total_amount,
    display_name = excluded.display_name,
    updated_at = CURRENT_TIMESTAMP
`);

const markDelivered = db.prepare(`
  UPDATE donations SET delivered = 1 WHERE id = ?
`);

const getUndeliveredDonation = db.prepare(`
  SELECT * FROM donations 
  WHERE delivered = 0 
  ORDER BY received_at ASC 
  LIMIT 1
`);

const getTopSpenders = db.prepare(`
  SELECT username, display_name, total_amount 
  FROM top_spenders 
  ORDER BY total_amount DESC 
  LIMIT 10
`);

const cleanOldDonations = db.prepare(`
  DELETE FROM donations 
  WHERE (delivered = 1 AND received_at < ?) 
     OR (received_at < ?)
`);

// Utility functions
function generateDonationId() {
  return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function cleanupOldDonations() {
  const now = Date.now();
  const deliveredThreshold = now - 60000; // 1 minute for delivered
  const undeliveredThreshold = now - 300000; // 5 minutes for undelivered
  
  try {
    const result = cleanOldDonations.run(deliveredThreshold, undeliveredThreshold);
    if (result.changes > 0) {
      console.log(`[Cleanup] Removed ${result.changes} old donations`);
    }
  } catch (error) {
    console.error('[Cleanup] Error:', error);
  }
}

// Auto-cleanup every 30 seconds
setInterval(cleanupOldDonations, 30000);

// Routes

// Health check
app.get('/', (req, res) => {
  try {
    const undelivered = db.prepare('SELECT COUNT(*) as count FROM donations WHERE delivered = 0').get();
    const total = db.prepare('SELECT COUNT(*) as count FROM donations').get();
    
    res.json({
      status: 'online',
      server: 'Railway Express + SQLite',
      queue_undelivered: undelivered.count,
      queue_total: total.count,
      endpoints: {
        saweria: '/saweria (POST)',
        roblox: '/roblox-check (GET)',
        confirm: '/roblox-check?confirm=DONATION_ID (GET)',
        debug: '/debug (GET)',
        clear: '/clear (POST)',
        stats: '/stats (GET)'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Database error', details: error.message });
  }
});

// Saweria webhook endpoint
app.post('/saweria', (req, res) => {
  try {
    const data = req.body;
    
    console.log('=== RAW DATA FROM SAWERIA ===');
    console.log(JSON.stringify(data, null, 2));
    
    const username = 
      data.donatur_name || 
      data.donator_name || 
      data.supporter_name || 
      data.supporter || 
      data.name || 
      data.username || 
      'Anonymous';
    
    const amount = 
      parseInt(data.amount_raw) || 
      parseInt(data.amount) || 
      parseInt(data.nominal) || 
      parseInt(data.donation) || 
      0;
    
    const message = 
      data.message || 
      data.pesan || 
      data.note || 
      data.comment || 
      '';
    
    const donationId = generateDonationId();
    const timestamp = new Date().toISOString();
    const receivedAt = Date.now();
    
    // Insert donation
    insertDonation.run(
      donationId,
      username,
      username, // display_name
      amount,
      message,
      timestamp,
      receivedAt
    );
    
    // Update top spender
    updateTopSpender.run(username, username, amount);
    
    console.log('=== DONATION SAVED ===');
    console.log('ID:', donationId);
    console.log('Username:', username);
    console.log('Amount:', amount);
    
    const queueCount = db.prepare('SELECT COUNT(*) as count FROM donations WHERE delivered = 0').get();
    
    res.json({
      success: true,
      donation_id: donationId,
      queue_size: queueCount.count
    });
  } catch (error) {
    console.error('[Saweria] Error:', error);
    res.status(400).json({
      error: 'Invalid data',
      details: error.message
    });
  }
});

// Roblox polling endpoint
app.get('/roblox-check', (req, res) => {
  try {
    const confirmId = req.query.confirm;
    
    // Handle delivery confirmation
    if (confirmId) {
      const result = markDelivered.run(confirmId);
      if (result.changes > 0) {
        console.log('[Roblox] Confirmed delivery:', confirmId);
      }
    }
    
    // Get next undelivered donation
    const donation = getUndeliveredDonation.get();
    const topSpenders = getTopSpenders.all();
    const queueCount = db.prepare('SELECT COUNT(*) as count FROM donations WHERE delivered = 0').get();
    
    res.json({
      donation: donation || null,
      top_spenders: topSpenders,
      queue_size: queueCount.count,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Roblox] Error:', error);
    res.status(500).json({
      error: 'Server error',
      details: error.message
    });
  }
});

// Debug endpoint
app.get('/debug', (req, res) => {
  try {
    const allDonations = db.prepare('SELECT * FROM donations ORDER BY received_at DESC LIMIT 20').all();
    const topSpenders = getTopSpenders.all();
    const undelivered = db.prepare('SELECT COUNT(*) as count FROM donations WHERE delivered = 0').get();
    const total = db.prepare('SELECT COUNT(*) as count FROM donations').get();
    
    res.json({
      donations: allDonations,
      top_spenders: topSpenders,
      undelivered_count: undelivered.count,
      total_count: total.count
    });
  } catch (error) {
    res.status(500).json({
      error: 'Database error',
      details: error.message
    });
  }
});

// Stats endpoint
app.get('/stats', (req, res) => {
  try {
    const stats = {
      total_donations: db.prepare('SELECT COUNT(*) as count FROM donations').get().count,
      delivered_donations: db.prepare('SELECT COUNT(*) as count FROM donations WHERE delivered = 1').get().count,
      pending_donations: db.prepare('SELECT COUNT(*) as count FROM donations WHERE delivered = 0').get().count,
      total_amount: db.prepare('SELECT SUM(amount) as sum FROM donations').get().sum || 0,
      unique_donors: db.prepare('SELECT COUNT(DISTINCT username) as count FROM donations').get().count,
      top_spenders: getTopSpenders.all()
    };
    
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Database error',
      details: error.message
    });
  }
});

// Clear endpoint (for testing)
app.post('/clear', (req, res) => {
  try {
    db.exec('DELETE FROM donations');
    db.exec('DELETE FROM top_spenders');
    
    console.log('[Clear] Database cleared');
    
    res.json({
      success: true,
      message: 'All data cleared'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Database error',
      details: error.message
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({
    error: 'Internal Server Error',
    details: err.message
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================`);
  console.log(`🚂 Railway Server Started`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`💾 Database: SQLite`);
  console.log(`✅ Ready for donations!`);
  console.log(`=================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing database...');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing database...');
  db.close();
  process.exit(0);
});
