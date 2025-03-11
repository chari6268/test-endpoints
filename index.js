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

// Store active WebSocket connections
const activeConnections = new Map();

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
          height: 300px;
          overflow-y: auto;
          border: 1px solid #ccc;
          padding: 10px;
          margin-bottom: 10px;
        }
        #userList {
          height: 200px;
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
        .private { background-color: #f3e5f5; }
        .user-item {
          cursor: pointer;
          padding: 5px;
          margin: 2px 0;
          border-radius: 3px;
        }
        .user-item:hover {
          background-color: #f5f5f5;
        }
        .selected-user {
          background-color: #e0e0e0;
        }
      </style>
    </head>
    <body>
      <h1>WebSocket Demo with Private Messaging</h1>
      <div style="display: flex; gap: 20px;">
        <div style="flex: 1;">
          <h3>Messages</h3>
          <div id="messages"></div>
          <div style="display: flex; gap: 10px;">
            <input type="text" id="messageInput" placeholder="Type a message..." style="flex: 1;">
            <button onclick="sendMessage()">Send</button>
          </div>
        </div>
        <div style="width: 200px;">
          <h3>Online Users</h3>
          <div id="userList"></div>
        </div>
      </div>

      <script>
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(wsProtocol + '//' + window.location.host);
        const messagesDiv = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const userListDiv = document.getElementById('userList');
        let selectedUser = null;
        let myUserId = null;

        ws.onopen = () => {
          console.log('Connected to WebSocket');
          appendMessage('Connected to server', 'system');
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          
          if (data.type === 'userId') {
            myUserId = data.userId;
            return;
          }

          if (data.type === 'userList') {
            updateUserList(data.users);
            return;
          }
          
          if (Array.isArray(data)) {
            // Handle message history
            data.forEach(msg => {
              appendMessage(msg.content, msg.type, msg.timestamp, msg.fromUserId, msg.toUserId);
            });
          } else {
            appendMessage(data.content, data.type, data.timestamp, data.fromUserId, data.toUserId);
          }
        };

        ws.onclose = () => {
          appendMessage('Disconnected from server', 'system');
        };

        function updateUserList(users) {
          userListDiv.innerHTML = '';
          users.forEach(user => {
            if (user.id !== myUserId) {
              const div = document.createElement('div');
              div.className = 'user-item' + (user.id === selectedUser ? ' selected-user' : '');
              div.textContent = \`User \${user.id.slice(0, 8)}...\`;
              div.onclick = () => selectUser(user.id);
              userListDiv.appendChild(div);
            }
          });
        }

        function selectUser(userId) {
          selectedUser = selectedUser === userId ? null : userId;
          updateUserList(Array.from(userListDiv.children).map(child => ({
            id: child.textContent.slice(5, -3)
          })));
          messageInput.placeholder = selectedUser ? 
            \`Send private message to User \${selectedUser.slice(0, 8)}...\` : 
            "Send message to everyone";
        }

        function appendMessage(message, type, timestamp = new Date().toLocaleTimeString(), fromUserId, toUserId) {
          const div = document.createElement('div');
          div.className = 'message ' + type;
          let prefix = '';
          
          if (type === 'private') {
            if (fromUserId === myUserId) {
              prefix = \`To User \${toUserId.slice(0, 8)}...: \`;
            } else {
              prefix = \`From User \${fromUserId.slice(0, 8)}...: \`;
            }
          }
          
          div.textContent = \`[\${timestamp}] \${prefix}\${message}\`;
          messagesDiv.appendChild(div);
          messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        function sendMessage() {
          const message = messageInput.value;
          if (message) {
            const messageData = {
              content: message,
              toUserId: selectedUser
            };
            ws.send(JSON.stringify(messageData));
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
  activeConnections.set(userId, ws);
  saveData();

  console.log('New client connected:', userId);

  // Send user their ID
  ws.send(JSON.stringify({
    type: 'userId',
    userId: userId
  }));

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

  // Broadcast updated user list
  const broadcastUserList = () => {
    const userList = Array.from(clientsData.values())
      .filter(client => activeConnections.has(client.id));
    
    const userListMessage = {
      type: 'userList',
      users: userList
    };

    wss.clients.forEach(client => {
      if (client.readyState === ws.OPEN) {
        client.send(JSON.stringify(userListMessage));
      }
    });
  };

  broadcastUserList();

  // Handle incoming messages
  ws.on('message', (message) => {
    let messageData;
    try {
      messageData = JSON.parse(message);
    } catch (e) {
      messageData = { content: message.toString() };
    }

    console.log('Received from', userId + ':', messageData.content);
    
    const messageObject = {
      type: messageData.toUserId ? 'private' : 'received',
      content: messageData.content,
      timestamp: new Date().toLocaleTimeString(),
      fromUserId: userId,
      toUserId: messageData.toUserId
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

    if (messageData.toUserId) {
      // Private message
      const targetWs = activeConnections.get(messageData.toUserId);
      if (targetWs && targetWs.readyState === ws.OPEN) {
        targetWs.send(JSON.stringify(messageObject));
      }
      // Send confirmation to sender
      ws.send(JSON.stringify({
        ...messageObject,
        type: 'private'
      }));
    } else {
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
    }
  });

  // Handle client disconnection
  ws.on('close', () => {
    console.log('Client disconnected:', userId);
    
    // Update client's last seen timestamp
    clientsData.set(userId, {
      ...clientsData.get(userId),
      lastSeen: new Date().toISOString()
    });
    activeConnections.delete(userId);
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

    // Broadcast updated user list
    broadcastUserList();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server is ready`);
  console.log(`Data directory: ${DATA_DIR}`);
});