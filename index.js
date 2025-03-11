const express = require('express');
const compression = require('compression');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// File paths for persistent storage
const DATA_DIR = path.join(__dirname, 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');

// Ensure data directory exists
fs.ensureDirSync(DATA_DIR);

// Initialize or load message history
let messageHistory = [];
try {
  messageHistory = fs.readJSONSync(MESSAGES_FILE, { throws: false }) || [];
} catch (error) {
  console.log('Creating new messages file');
  fs.writeJSONSync(MESSAGES_FILE, []);
}

// Initialize or load client information
let clientsData = new Map();
try {
  const loadedClients = fs.readJSONSync(CLIENTS_FILE, { throws: false }) || {};
  clientsData = new Map(Object.entries(loadedClients));
} catch (error) {
  console.log('Creating new clients file');
  fs.writeJSONSync(CLIENTS_FILE, {});
}

// Save data to files
const saveData = () => {
  try {
    fs.writeJSONSync(MESSAGES_FILE, messageHistory);
    fs.writeJSONSync(CLIENTS_FILE, Object.fromEntries(clientsData));
  } catch (error) {
    console.error('Error saving data:', error);
  }
};

// Enable CORS, compression, and cookie parsing
app.use(cors());
app.use(compression());
app.use(cookieParser());
app.use(express.json());

// Serve a simple HTML page with WebSocket client
app.get('/', (req, res) => {
  // Set a user ID cookie if not present
  if (!req.cookies.userId) {
    res.cookie('userId', uuidv4(), { httpOnly: true });
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WebSocket Demo</title>
      <style>
        #messages {
          height: 400px;
          overflow-y: auto;
          border: 1px solid #ccc;
          padding: 10px;
          margin-bottom: 10px;
        }
        .message {
          margin: 5px 0;
          padding: 5px;
          border-radius: 5px;
        }
        .received { background-color: #e3f2fd; }
        .sent { background-color: #e8f5e9; }
        .system { background-color: #fff3e0; font-style: italic; }
      </style>
    </head>
    <body>
      <h1>WebSocket Demo with Message History</h1>
      <div id="messages"></div>
      <input type="text" id="messageInput" placeholder="Type a message...">
      <button onclick="sendMessage()">Send</button>

      <script>
        const ws = new WebSocket('ws://' + window.location.host);
        const messagesDiv = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');

        ws.onopen = () => {
          console.log('Connected to WebSocket');
          appendMessage('Connected to server', 'system');
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          
          if (Array.isArray(data)) {
            // Handle message history
            data.forEach(msg => {
              appendMessage(msg.content, msg.type, msg.timestamp);
            });
          } else {
            appendMessage(data.content, data.type, data.timestamp);
          }
        };

        ws.onclose = () => {
          appendMessage('Disconnected from server', 'system');
        };

        function appendMessage(message, type, timestamp = new Date().toLocaleTimeString()) {
          const div = document.createElement('div');
          div.className = 'message ' + type;
          div.textContent = \`[\${timestamp}] \${message}\`;
          messagesDiv.appendChild(div);
          messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        function sendMessage() {
          const message = messageInput.value;
          if (message) {
            ws.send(message);
            messageInput.value = '';
          }
        }

        // Handle Enter key
        messageInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
            sendMessage();
          }
        });
      </script>
    </body>
    </html>
  `);
});

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const userId = req.headers.cookie?.split(';')
    .find(c => c.trim().startsWith('userId='))
    ?.split('=')[1] || uuidv4();
  
  // Store client information
  const clientInfo = {
    id: userId,
    connectedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  };
  
  clientsData.set(userId, clientInfo);
  saveData();

  console.log('New client connected:', userId);

  // Send message history to new client
  ws.send(JSON.stringify(messageHistory));

  // Send welcome message
  const welcomeMessage = {
    type: 'system',
    content: 'Welcome to the WebSocket server!',
    timestamp: new Date().toLocaleTimeString(),
    userId: userId
  };
  ws.send(JSON.stringify(welcomeMessage));
  messageHistory.push(welcomeMessage);
  saveData();

  // Handle incoming messages
  ws.on('message', (message) => {
    console.log('Received from', userId + ':', message.toString());
    
    const messageObject = {
      type: 'received',
      content: message.toString(),
      timestamp: new Date().toLocaleTimeString(),
      userId: userId
    };

    // Store in message history
    messageHistory.push(messageObject);
    if (messageHistory.length > 100) {
      messageHistory.shift(); // Keep only last 100 messages
    }
    saveData();

    // Update client's last seen timestamp
    clientsData.set(userId, {
      ...clientsData.get(userId),
      lastSeen: new Date().toISOString()
    });
    saveData();

    // Broadcast to all clients except sender
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === ws.OPEN) {
        client.send(JSON.stringify({
          ...messageObject,
          type: client === ws ? 'sent' : 'received'
        }));
      }
    });

    // Send confirmation to sender
    ws.send(JSON.stringify({
      ...messageObject,
      type: 'sent'
    }));
  });

  // Handle client disconnection
  ws.on('close', () => {
    console.log('Client disconnected:', userId);
    
    // Update client's last seen timestamp
    clientsData.set(userId, {
      ...clientsData.get(userId),
      lastSeen: new Date().toISOString()
    });
    saveData();

    // Broadcast disconnection message
    const disconnectMessage = {
      type: 'system',
      content: `User ${userId} disconnected`,
      timestamp: new Date().toLocaleTimeString(),
      userId: userId
    };
    messageHistory.push(disconnectMessage);
    saveData();

    wss.clients.forEach((client) => {
      if (client.readyState === ws.OPEN) {
        client.send(JSON.stringify(disconnectMessage));
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server is ready`);
  console.log(`Data directory: ${DATA_DIR}`);
});