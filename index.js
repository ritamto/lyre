const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// ==========================================
// 1. MIDDLEWARE
// ==========================================

// Custom logger: Logs request method, URL, and timestamp
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Parse incoming JSON payloads
app.use(express.json());

// Parse incoming URL-encoded form data
app.use(express.urlencoded({ extended: true }));

// Serve static files (index.html, style.css, images, etc.) from the public/current directory
app.use(express.static(path.join(__dirname)));

// ==========================================
// 2. ROUTES
// ==========================================

// Basic GET route returning JSON
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Dynamic Route Parameter (e.g. GET /api/user/alex)
app.get('/api/user/:name', (req, res) => {
  const { name } = req.params;
  res.json({ message: `Hello, ${name}! Welcome to the app.` });
});

// POST route accepting JSON input
app.post('/api/echo', (req, res) => {
  const data = req.body;
  res.status(201).json({
    message: 'Data received successfully!',
    dataReceived: data
  });
});

// ==========================================
// 3. ERROR HANDLING & 404
// ==========================================

// Catch 404 for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on the server!' });
});

// ==========================================
// 4. SERVER INITIALIZATION
// ==========================================

app.listen(port, () => {
  console.log(`🚀 Express server running at http://localhost:${port}`);
});