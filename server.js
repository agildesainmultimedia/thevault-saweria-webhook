const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory storage (akan reset saat server restart)
let donationQueue = [];
let topSpenders = {};
let lastRawData = null;

const MAX_QUEUE_SIZE = 20;
const DONATION_LIFETIME = 120000; // 2 minutes

function generateDonationId() {
  return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function cleanupOldDonations() {
  const now = Date.now();
  donationQueue = donationQueue.filter(d => {
    const age = now - d.received_at;
    if (age > DONATION_LIFETIME) return false;
    if (d.delivered && age > 30000) return false;
    return true;
  });
}

// Auto-cleanup every 30 seconds
setInterval(cleanupOldDonations, 30000);

// Routes

// Health check
app.get('/', (req, res) => {
  const undelivered = donationQueue.filter(d => !d.delivered).length;
  
  res.json({
    status: 'online',
    server: 'Railway Express (In-Memory)',
    queue_undelivered: undelivered,
    queue_total: donationQueue.length,
    uptime: process.uptime(),
    endpoints: {
      saweria: '/saweria (POST)',
      roblox: '/roblox-check (GET)',
      confirm: '/roblox-check?confirm=DONATION_ID (GET)',
      debug: '/debug (GET)',
      clear: '/clear (POST)',
      stats: '/stats (GET)'
    }
  });
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
    
    const donation = {
      id: donationId,
      username: username,
      display_name: username,
      amount: amount,
      message: message,
      timestamp: new Date().toISOString(),
      received_at: Date.now(),
      delivered: false,
      avatar_url: null
    };

    // Add to queue
    donationQueue.push(donation);
    
    // Keep queue size manageable
    if (donationQueue.length > MAX_QUEUE_SIZE) {
      donationQueue.shift();
    }

    // Update top spenders
    if (!topSpenders[username]) {
      topSpenders[username] = {
        username: username,
        display_name: username,
        total_amount: 0
      };
    }
    topSpenders[username].total_amount += amount;
    
    console.log('=== DONATION SAVED ===');
    console.log('ID:', donationId);
    console.log('Username:', username);
    console.log('Amount:', amount);
    console.log('Queue size:', donationQueue.length);
    
    res.json({
      success: true,
      donation_id: donationId,
      queue_size: donationQueue.filter(d => !d.delivered).length
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
      const donation = donationQueue.find(d => d.id === confirmId);
      if (donation) {
        donation.delivered = true;
        console.log('[Roblox] Confirmed delivery:', confirmId);
      }
    }
    
    // Get next undelivered donation
    const nextDonation = donationQueue.find(d => !d.delivered);
    
    const topSpendersList = Object.values(topSpenders)
      .sort((a, b) => b.total_amount - a.total_amount)
      .slice(0, 10);
    
    const undelivered = donationQueue.filter(d => !d.delivered).length;
    
    res.json({
      donation: nextDonation || null,
      top_spenders: topSpendersList,
      queue_size: undelivered,
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
  const undelivered = donationQueue.filter(d => !d.delivered).length;
  
  res.json({
    last_raw_data: lastRawData,
    donation_queue: donationQueue,
    top_spenders: topSpenders,
    undelivered_count: undelivered,
    total_count: donationQueue.length
  });
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const delivered = donationQueue.filter(d => d.delivered).length;
  const pending = donationQueue.filter(d => !d.delivered).length;
  const totalAmount = donationQueue.reduce((sum, d) => sum + d.amount, 0);
  
  res.json({
    total_donations: donationQueue.length,
    delivered_donations: delivered,
    pending_donations: pending,
    total_amount: totalAmount,
    unique_donors: Object.keys(topSpenders).length,
    top_spenders: Object.values(topSpenders)
      .sort((a, b) => b.total_amount - a.total_amount)
      .slice(0, 10)
  });
});

// Clear endpoint (for testing)
app.post('/clear', (req, res) => {
  donationQueue = [];
  topSpenders = {};
  lastRawData = null;
  
  console.log('[Clear] All data cleared');
  
  res.json({
    success: true,
    message: 'All data cleared'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    message: 'This endpoint does not exist'
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
  console.log(`💾 Storage: In-Memory`);
  console.log(`✅ Ready for donations!`);
  console.log(`=================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  process.exit(0);
});
