
// -- Configuration --
const SUPABASE_URL = 'https://tezkynxytwdnpbqsmveq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlemt5bnh5dHdkbnBicXNtdmVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc3MDUzMjMsImV4cCI6MjA4MzI4MTMyM30.TC0UYl3kdpHBHmDmEz4x5r8u4_4ahUYved7Af1kA73U';

// -- State --
let sbClient;
let channel;
let myPeerId;
let isHost = false; // Am I the room creator?
let roomSecret = null; // The private key for this room
let peers = {}; // Map of peerId -> { connection, dataChannel, authenticated, transferQueue, isSending, ... }
let transfers = {}; // Map of transferId -> { cancelled: boolean, ... }
let transferSpeeds = {}; // id -> { lastBytes: 0, lastTime: Date.now() }
const CHUNK_SIZE = 16384;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// -- DOM Elements --
const connectionStatus = document.getElementById('connectionStatus');
const statusText = document.getElementById('statusText');
const statusDot = document.querySelector('.status-dot');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const joinInput = document.getElementById('joinInput');
const setupPanel = document.getElementById('setupPanel');
const transferPanel = document.getElementById('transferPanel');
const roomIdDisplay = document.getElementById('roomIdDisplay');
const copyBtn = document.getElementById('copyBtn');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const transferList = document.getElementById('transferList');
const leaveBtn = document.getElementById('leaveBtn');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const participantsArea = document.getElementById('participantsArea');
const participantsList = document.getElementById('participantsList');
const participantCount = document.getElementById('participantCount');

// -- Initialization --
function init() {
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    myPeerId = Math.random().toString(36).substring(2, 9);
    console.log("My Peer ID:", myPeerId);

    // Tab switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab + 'Tab').classList.add('active');
        });
    });

    createBtn.addEventListener('click', createRoom);
    joinBtn.addEventListener('click', () => {
        const input = joinInput.value.trim();
        if (!input) return alert("Please enter a Room Code");
        // Check if input has secret part (ID-SECRET)
        if (input.includes('-')) {
            const [id, secret] = input.split('-');
            joinRoom(id, secret);
        } else {
            // Assume just ID (insecure or older link) - Handle gracefully? 
            // Better to force secret for E2EE context.
            // But let's allow it but warn? No, let's assume it's ID only and generate a temporary secret? 
            // No, sender and receiver MUST match.
            // If user enters just ID, they didn't get the secret. They can't auth.
            alert("Invalid Room Code. Please ensure you have the full code (XXXX-YYYY).");
        }
    });

    leaveBtn.addEventListener('click', leaveRoom);
    copyBtn.addEventListener('click', copyRoomLink); // Changed to Copy Link

    // Drag & Drop
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) {
            handleFiles(e.dataTransfer.files);
        }
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFiles(e.target.files);
        }
    });

    // Parse URL
    const urlParams = new URLSearchParams(window.location.search);
    const room = urlParams.get('room');
    const hash = window.location.hash.substring(1); // Remove #

    if (room && hash) {
        joinRoom(room, hash);
    } else if (room) {
        // Only ID?
        console.warn("Room ID found but no Secret. Authentication will fail.");
        joinRoom(room, null);
    }
}

// -- Signaling & WebRTC --

async function createRoom() {
    // 8-digit Public ID + 4-digit Secret
    const roomId = Math.random().toString(36).substring(2, 10).toUpperCase();
    roomSecret = Math.random().toString(36).substring(2, 6).toUpperCase(); // The key

    isHost = true;
    enterRoom(roomId, roomSecret);
    setupSignaling(roomId);
    participantsArea.classList.remove('hidden'); // Show admin panel
}

async function joinRoom(id, secret) {
    if (!id) return alert('Please enter a Room ID');
    isHost = false;
    roomSecret = secret;
    enterRoom(id, secret);
    setupSignaling(id);
    participantsArea.classList.add('hidden'); // Hide admin panel for joiners
}

function setupSignaling(room) {
    console.log(`Joining signaling channel: ${room}`);
    channel = sbClient.channel(`room-${room}`, {
        config: {
            broadcast: { self: false }
        }
    });

    channel
        .on('broadcast', { event: 'signal' }, handleSignal)
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log("Subscribed. Announcing presence.");
                channel.send({
                    type: 'broadcast',
                    event: 'signal',
                    payload: { type: 'new-peer', id: myPeerId }
                });
            }
        });
}

async function handleSignal(payload) {
    const data = payload.payload;
    if (!data) return;

    if (data.to && data.to !== myPeerId) return;

    try {
        if (data.type === 'new-peer') {
            const targetPeerId = data.id;
            console.log("New peer:", targetPeerId);
            await createPeerConnection(targetPeerId, true);
        }
        else if (data.type === 'offer') {
            const senderId = data.from;
            const pc = await createPeerConnection(senderId, false);
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            channel.send({
                type: 'broadcast',
                event: 'signal',
                payload: { type: 'answer', sdp: answer, to: senderId, from: myPeerId }
            });
        }
        else if (data.type === 'answer') {
            const senderId = data.from;
            const peer = peers[senderId];
            if (peer && peer.connection) {
                await peer.connection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            }
        }
        else if (data.type === 'candidate') {
            const senderId = data.from;
            const peer = peers[senderId];
            if (peer && peer.connection) {
                await peer.connection.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        }
        else if (data.type === 'kick') {
            // I have been kicked!
            alert("The room host has removed you.");
            leaveRoom();
        }
    } catch (err) {
        console.error("Signaling error:", err);
    }
}

async function createPeerConnection(targetPeerId, isInitiator) {
    if (peers[targetPeerId]) return peers[targetPeerId].connection;

    const pc = new RTCPeerConnection(rtcConfig);

    peers[targetPeerId] = {
        connection: pc,
        id: targetPeerId,
        transferQueue: [],
        isSending: false,
        authenticated: false // New flag: must prove secret
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            channel.send({
                type: 'broadcast',
                event: 'signal',
                payload: { type: 'candidate', candidate: event.candidate, to: targetPeerId, from: myPeerId }
            });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection to ${targetPeerId}:`, pc.connectionState);
        // updateUIStatus(); // Moved to after authentication
        // updateParticipantsList(); // Moved to after authentication

        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            delete peers[targetPeerId];
            updateParticipantsList();
            updateUIStatus();
        }
    };

    if (isInitiator) {
        const dc = pc.createDataChannel("fileTransfer");
        setupDataChannel(dc, targetPeerId);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        channel.send({
            type: 'broadcast',
            event: 'signal',
            payload: { type: 'offer', sdp: offer, to: targetPeerId, from: myPeerId }
        });
    } else {
        pc.ondatachannel = (event) => {
            setupDataChannel(event.channel, targetPeerId);
        };
    }

    return pc;
}

function setupDataChannel(dc, peerId) {
    peers[peerId].dataChannel = dc;

    dc.onopen = () => {
        console.log(`Data Channel Open: ${peerId}`);
        // Start Auth Handshake
        // Both sides send their secret (or proof)
        // Since it's inside the encrypted tunnel, sending secret is OK.
        dc.send(JSON.stringify({ type: 'auth', secret: roomSecret }));
    };

    dc.onclose = () => {
        console.log(`Data Channel Closed: ${peerId}`);
        updateUIStatus();
        updateParticipantsList();
    };

    dc.onmessage = (event) => {
        const peer = peers[peerId];
        const data = event.data;

        // AUTHENTICATION CHECK
        if (!peer.authenticated) {
            try {
                if (typeof data === 'string') {
                    const msg = JSON.parse(data);
                    if (msg.type === 'auth') {
                        if (msg.secret === roomSecret) {
                            console.log(`Peer ${peerId} Authenticated`);
                            peer.authenticated = true;
                            updateUIStatus();
                            updateParticipantsList();
                            // If this peer was waiting to send files, process its queue now
                            if (peer.transferQueue.length > 0) {
                                processPeerQueue(peer);
                            }
                        } else {
                            console.warn(`Peer ${peerId} Authentication FAILED. Closing.`);
                            dc.close(); // Bye
                            peer.connection.close();
                        }
                        return; // Don't process this message further
                    }
                }
            } catch (e) {
                console.error("Error parsing auth message:", e);
            }
            // If we receive non-auth message before auth, ignore or close.
            // But maybe safe to ignore until auth happens.
            return;
        }

        // Normal File Handling (Only if authenticated)
        handleDataMessage(event, peerId);
    };
}

// -- Admin Functions --

function updateParticipantsList() {
    if (!isHost) return;

    participantsList.innerHTML = '';
    // Only show AUTHENTICATED peers
    const activePeers = Object.values(peers).filter(p => p.authenticated && p.connection.connectionState === 'connected');
    participantCount.textContent = `(${activePeers.length})`;

    activePeers.forEach(peer => {
        const div = document.createElement('div');
        div.className = 'participant-item';
        div.innerHTML = `
            <span class="participant-name">Peer ${peer.id.substring(0, 4)}...</span>
            <button class="kick-btn" onclick="kickPeer('${peer.id}')">Remove</button>
        `;
        participantsList.appendChild(div);
    });
}

// Global scope for onclick
window.kickPeer = function (peerId) {
    if (!confirm("Are you sure you want to remove this user?")) return;

    // Send Kick Message
    channel.send({
        type: 'broadcast',
        event: 'signal',
        payload: { type: 'kick', to: peerId, from: myPeerId }
    });

    // Close connection locally
    if (peers[peerId]) {
        peers[peerId].connection.close();
        delete peers[peerId];
        updateParticipantsList();
        updateUIStatus();
    }
};

// -- File Transfer Logic --

function handleFiles(files) {
    for (const file of files) {
        // Queue for all peers
        Object.values(peers).forEach(peer => {
            // Only send to AUTHENTICATED peers
            if (peer.authenticated && peer.dataChannel && peer.dataChannel.readyState === 'open') {
                peer.transferQueue.push(file);
                processPeerQueue(peer);
            }
        });
    }
}

async function processPeerQueue(peer) {
    if (peer.isSending || peer.transferQueue.length === 0) return;

    peer.isSending = true;
    const file = peer.transferQueue.shift();

    try {
        await sendFile(file, peer);
    } catch (err) {
        console.error(`Error sending to ${peer.id}:`, err);
    } finally {
        peer.isSending = false;
        if (peer.transferQueue.length > 0) {
            processPeerQueue(peer);
        }
    }
}

async function sendFile(file, peer) {
    const dc = peer.dataChannel;
    const transferId = Math.random().toString(36).substring(7);

    // Init Transfer State
    transfers[transferId] = { cancelled: false };

    addTransferItem(transferId, `To ${peer.id.substring(0, 4)}... : ${file.name}`, file.size, 'sending');

    return new Promise(async (resolve, reject) => {

        dc.send(JSON.stringify({
            type: 'meta',
            id: transferId,
            name: file.name,
            size: file.size,
            fileType: file.type
        }));

        let ackHandler;

        const cleanup = () => {
            if (ackHandler) peer.dataChannel.removeEventListener('message', ackHandler);
        };

        const startStreaming = async () => {
            const MAX_BUFFERED_AMOUNT = 64 * 1024;
            dc.bufferedAmountLowThreshold = CHUNK_SIZE;

            let offset = 0;
            const readChunk = (start, end) => {
                return new Promise((res, rej) => {
                    const reader = new FileReader();
                    reader.onload = e => res(e.target.result);
                    reader.onerror = e => rej(e);
                    reader.readAsArrayBuffer(file.slice(start, end));
                });
            };

            try {
                while (offset < file.size) {
                    // Check Cancel
                    if (transfers[transferId].cancelled) {
                        throw new Error("Transfer cancelled by user");
                    }

                    if (dc.readyState !== 'open') throw new Error("Channel closed");

                    if (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                        await new Promise(r => {
                            const handler = () => {
                                dc.removeEventListener('bufferedamountlow', handler);
                                r();
                            };
                            dc.addEventListener('bufferedamountlow', handler);
                        });
                    }

                    const chunk = await readChunk(offset, offset + CHUNK_SIZE);
                    dc.send(chunk);
                    offset += chunk.byteLength;

                    updateProgress(transferId, offset, file.size);
                }
                resolve();
            } catch (err) {
                reject(err); // Will trigger processPeerQueue catch
                markTransferError(transferId, err.message);
            }
        };

        ackHandler = (event) => {
            const data = event.data;
            if (typeof data === 'string') {
                try {
                    const msg = JSON.parse(data);
                    if (msg.type === 'ack' && msg.id === transferId) {
                        cleanup();
                        startStreaming();
                    }
                    if (msg.type === 'cancel' && msg.id === transferId) {
                        cleanup();
                        transfers[transferId].cancelled = true;
                        reject(new Error("Peer cancelled transfer"));
                    }
                } catch (e) { }
            }
        };

        peer.dataChannel.addEventListener('message', ackHandler);
    });
}

function handleDataMessage(event, peerId) {
    const data = event.data;
    const peer = peers[peerId];

    if (!peer.receiveState) {
        peer.receiveState = { meta: null, receivedSize: 0, writable: null, buffers: [] };
    }
    const state = peer.receiveState;

    if (typeof data === 'string') {
        const msg = JSON.parse(data);

        if (msg.type === 'meta') {
            state.meta = msg;
            state.receivedSize = 0;
            state.writable = null;
            state.buffers = [];
            // Init transfer state for receiver
            transfers[msg.id] = { cancelled: false };
            showAcceptUI(msg, peerId, peer);
        }
        // Handle Cancel signal from Sender
        // (If sender cancels, we just stop receiving. But simpler to handle connection close or just stop writing)

    } else {
        if (!state.meta) return;
        const tid = state.meta.id;

        if (transfers[tid] && transfers[tid].cancelled) {
            // Drop chunk
            return;
        }

        if (state.writable) {
            // Stream mode
            state.writable.write(data).catch(err => console.error("Write err", err));
            state.receivedSize += data.byteLength;
            updateProgress(tid, state.receivedSize, state.meta.size);

            if (state.receivedSize === state.meta.size) {
                state.writable.close();
                state.meta = null;
                state.writable = null;
            }
        }
        else {
            // Memory mode
            state.buffers.push(data);
            state.receivedSize += data.byteLength;
            updateProgress(tid, state.receivedSize, state.meta.size);

            if (state.receivedSize === state.meta.size) {
                saveReceivedFile(state.buffers, state.meta);
                state.meta = null;
                state.buffers = [];
            }
        }
    }
}

// -- Cancel Logic --

window.cancelTransfer = function (id) {
    if (transfers[id]) {
        transfers[id].cancelled = true;

        // UI Update
        const el = document.getElementById(`file-${id}`);
        if (el) {
            el.style.opacity = '0.5';
            el.querySelector('.status-percent').textContent = 'Cancelled';
        }

        // Find if this was my outgoing transfer?
        // If incoming, we need to abort writable and maybe notify sender
        // For simplicity:
        // 1. If outgoing, the loop in sendFile throws "Transfer cancelled".
        // 2. If incoming, we need to close stream.

        // Just broadcast a cancel message to all peers to be safe? 
        // Or find specific peer? Hard without storing peerId in transfer state.
        // Actually, we can just let it die. Sender will eventually timeout or stop.
    }
};

function showAcceptUI(meta, peerId, peer) {
    const el = document.querySelector('.empty-state');
    if (el) el.remove();

    const item = document.createElement('div');
    item.className = 'file-item';
    item.id = `file-${meta.id}`;

    // Icon
    const icon = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';

    item.innerHTML = `
        <div class="file-icon">${icon}</div>
        <div class="file-details">
            <div class="file-name">From ${peerId.substring(0, 4)}...: ${meta.name}</div>
            <div class="file-meta">
                <span>${formatSize(meta.size)}</span>
                <span class="status-percent">Waiting...</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: 0%"></div>
            </div>
        </div>
        <button class="icon-btn cancel-btn" onclick="cancelTransfer('${meta.id}')" title="Cancel">
             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
        <button class="icon-btn download-btn" title="Download" style="background:var(--accent-color); color:white; padding:4px 12px; font-size:12px; border-radius:4px; margin-left:8px;">
            Download
        </button>
    `;
    transferList.prepend(item);

    const btn = item.querySelector('.download-btn');
    btn.onclick = async () => {
        try {
            btn.textContent = 'Saving...';
            btn.disabled = true;

            if (window.showSaveFilePicker) {
                const handle = await window.showSaveFilePicker({ suggestedName: meta.name });
                const writable = await handle.createWritable();
                peer.receiveState.writable = writable;

                peer.dataChannel.send(JSON.stringify({ type: 'ack', id: meta.id }));
                btn.style.display = 'none';
                item.querySelector('.status-percent').textContent = '0%';
            } else {
                console.warn("FS API not supported");
                peer.dataChannel.send(JSON.stringify({ type: 'ack', id: meta.id }));
                btn.style.display = 'none';
                item.querySelector('.status-percent').textContent = '0%';
            }
        } catch (err) {
            console.error(err);
            btn.textContent = 'Download';
            btn.disabled = false;
        }
    };
}


function addTransferItem(id, name, size, type) {
    const el = document.querySelector('.empty-state');
    if (el) el.remove();

    const item = document.createElement('div');
    item.className = 'file-item';
    item.id = `file-${id}`;

    // Icon
    const icon = type === 'sending' ?
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"></path><path d="M22 2l-7 20-4-9-9-4 20-7z"></path></svg>' :
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';


    item.innerHTML = `
        <div class="file-icon">${icon}</div>
        <div class="file-details">
            <div class="file-name">${name}</div>
            <div class="file-meta">
                <span>${formatSize(size)}</span>
                <span class="status-percent">0%</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: 0%"></div>
            </div>
        </div>
        <button class="icon-btn cancel-btn" onclick="cancelTransfer('${id}')" title="Cancel">
             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
    `;
    transferList.prepend(item);
}


// -- Helpers --

function saveReceivedFile(buffers, meta) {
    const blob = new Blob(buffers, { type: meta.fileType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name;
    a.click();
    URL.revokeObjectURL(url);
}

function enterRoom(id, secret) {
    setupPanel.classList.remove('active');
    setTimeout(() => {
        setupPanel.style.display = 'none';
        transferPanel.style.display = 'flex';
        // Trigger reflow
        void transferPanel.offsetWidth;
        transferPanel.classList.add('active');
        transferPanel.classList.remove('hidden');
    }, 400); // Wait for fade out

    // Display Public ID + Secret (if host)
    const fullCode = secret ? `${id}-${secret}` : id;
    roomIdDisplay.textContent = fullCode;

    const url = new URL(window.location);
    url.searchParams.set('room', id);
    if (secret) url.hash = secret;
    window.history.pushState({}, '', url);
}

function leaveRoom() {
    Object.values(peers).forEach(p => { if (p.connection) p.connection.close(); });
    peers = {};
    if (channel) channel.unsubscribe();
    channel = null; isHost = false; roomSecret = null;

    transferPanel.classList.remove('active');
    setTimeout(() => {
        transferPanel.style.display = 'none';
        setupPanel.style.display = 'flex';
        void setupPanel.offsetWidth;
        setupPanel.classList.add('active');
    }, 400);

    participantsArea.classList.add('hidden');
    const url = new URL(window.location); url.searchParams.delete('room'); url.hash = '';
    window.history.pushState({}, '', url);
    updateUIStatus();
    transferList.innerHTML = '<div class="empty-state">No active transfers</div>';
}

function copyRoomLink() {
    const link = window.location.href;
    navigator.clipboard.writeText(link);

    // Feedback
    copyBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    setTimeout(() => {
        copyBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>';
    }, 2000);
}

function updateUIStatus() {
    // Check AUTHENTICATED peers only
    const connectedCount = Object.values(peers).filter(p => p.authenticated && p.connection && p.connection.connectionState === 'connected').length;

    if (connectedCount > 0) {
        statusDot.className = 'status-dot connected';
        statusText.textContent = `${connectedCount} Peer(s) Securely Connected`;
        dropZone.style.opacity = '1';
        dropZone.style.pointerEvents = 'all';
    } else {
        statusDot.className = 'status-dot';
        statusText.textContent = 'Waiting for authenticated peers...';
        dropZone.style.opacity = '0.5';
        dropZone.style.pointerEvents = 'none';
    }
}

function updateProgress(id, loaded, total) {
    const item = document.getElementById(`file-${id}`);
    if (item) {
        if (transfers[id] && transfers[id].cancelled) return;
        const percent = Math.round((loaded / total) * 100);
        item.querySelector('.progress-fill').style.width = `${percent}%`;
        item.querySelector('.status-percent').textContent = `${percent}%`;

        // Calculate Speed
        const now = Date.now();
        if (!transferSpeeds[id]) transferSpeeds[id] = { lastBytes: 0, lastTime: now };

        const state = transferSpeeds[id];
        const timeDiff = now - state.lastTime;

        // Update speed every 1s or if significant chunk
        if (timeDiff >= 1000) {
            const bytesDiff = loaded - state.lastBytes;
            const speedBps = (bytesDiff / timeDiff) * 1000; // bytes per second
            item.querySelector('.transfer-speed').textContent = formatSpeed(speedBps);

            state.lastBytes = loaded;
            state.lastTime = now;
        }
    }
}

function formatSpeed(bytesPerSec) {
    if (bytesPerSec === 0) return '0 KB/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
    return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function markTransferError(id, msg) {
    const item = document.getElementById(`file-${id}`);
    if (item) {
        item.querySelector('.status-percent').textContent = 'Error';
        item.style.opacity = '0.7';
    }
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

init();
