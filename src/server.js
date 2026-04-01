require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/agent', require('./routes/agent'));
app.use('/api/client', require('./routes/client'));
app.use('/api/webhook', require('./routes/webhook'));

// Serve static files (widget)
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Agent API running on port ${PORT}`);
  });
}

module.exports = app;
