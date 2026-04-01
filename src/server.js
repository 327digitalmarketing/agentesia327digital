require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Servir archivos estáticos del widget
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// Endpoints especiales para archivos del widget
app.get('/chat-iframe.html', (req, res) => {
  res.sendFile(path.join(publicPath, 'chat-iframe.html'));
});

app.get('/chat-widget.js', (req, res) => {
  res.sendFile(path.join(publicPath, 'chat-widget.js'));
});

app.get('/chat-styles.css', (req, res) => {
  res.sendFile(path.join(publicPath, 'chat-styles.css'));
});

// Routes
app.use('/api/agent', require('./routes/agent'));
app.use('/api/client', require('./routes/client'));
app.use('/api/webhook', require('./routes/webhook'));

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
