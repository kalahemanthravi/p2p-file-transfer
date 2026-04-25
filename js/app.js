/* ═══════════════════════════════════════════════════════════
   FridayTransfer — Main Application (1:1 Only, No Group)
   ═══════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    let conn = null;
    let transfer = null;
    let currentScreen = 'dashboard';

    const $ = (id) => document.getElementById(id);
    const screens = { dashboard: $('dashboard-screen'), room: $('room-screen') };

    // Dashboard
    const createRoomBtn = $('create-room-btn');
    const joinCodeInput = $('join-code-input');
    const joinBtn = $('join-btn');
    const systemLoad = $('system-load');

    // Room
    const peersCountNum = $('peers-count-num');
    const roomCodeText = $('room-code-text');
    const roomLinkText = $('room-link-text');
    const qrCanvas = $('qr-canvas');
    const peersList = $('peers-list');
    const dropZone = $('drop-zone');
    const fileInput = $('file-input');
    const queuedSection = $('queued-files-section');
    const queuedList = $('queued-files-list');
    const sendAllBtn = $('send-all-btn');
    const clearQueueBtn = $('clear-queue-btn');
    const activeTransferSection = $('active-transfer-section');
    const waitingSection = $('waiting-section');
    const completedSection = $('completed-section');
    const completedList = $('completed-list');
    const backBtn = $('back-btn');
    const leaveRoomBtn = $('leave-room-btn');
    const killTransferBtn = $('kill-transfer-btn');
    const cancelWaitingBtn = $('cancel-waiting-btn');

    // Modals
    const transferModal = $('transfer-modal');
    const modalAcceptBtn = $('modal-accept-btn');
    const modalDenyBtn = $('modal-deny-btn');
    const peerLeftModal = $('peer-left-modal');
    const peerLeftOkBtn = $('peer-left-ok-btn');

    // ═══════════ SCREEN ═══════════
    function showScreen(name) {
        for (const [k, el] of Object.entries(screens)) el.classList.toggle('active', k === name);
        currentScreen = name;
    }

    // ═══════════ TOAST ═══════════
    function toast(msg, type = 'info', dur = 4000) {
        const container = $('toast-container');
        const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span>${msg}</span>`;
        container.appendChild(el);
        setTimeout(() => { el.classList.add('toast-out'); setTimeout(() => el.remove(), 300); }, dur);
    }

    // ═══════════ SYSTEM LOAD ═══════════
    async function updateSystemLoad() {
        try {
            const t = new FT.ConnectionManager();
            const cap = await t.getCapacity();
            if (systemLoad) {
                const load = cap.load_percent || 0;
                let color = 'var(--accent-green)', label = 'Low';
                if (load > 70) { color = 'var(--accent-red)'; label = 'High'; }
                else if (load > 40) { color = 'var(--accent-amber)'; label = 'Medium'; }
                systemLoad.innerHTML = `<span style="color:${color}">●</span> System Load: ${label} <span class="load-detail">(${cap.active_rooms}/${cap.max_rooms} rooms)</span>`;
                systemLoad.style.display = 'flex';
            }
        } catch (e) { }
    }

    // ═══════════ CREATE ROOM (always 1:1) ═══════════
    createRoomBtn.addEventListener('click', async () => {
        try {
            createRoomBtn.disabled = true;
            createRoomBtn.querySelector('.btn-content').textContent = '⏳ Creating...';
            conn = new FT.ConnectionManager();
            const userCode = await conn.createRoom('pair');
            transfer = new FT.TransferManager(conn);
            wireAll();
            enterRoom(userCode);
            toast('Room created! Share the code.', 'success');
        } catch (err) {
            toast('Failed: ' + err.message, 'error');
            conn = null;
        } finally {
            createRoomBtn.disabled = false;
            createRoomBtn.querySelector('.btn-content').textContent = '🚀 Start Transfer';
        }
    });

    // ═══════════ JOIN ROOM ═══════════
    joinCodeInput.addEventListener('input', () => {
        let v = joinCodeInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4, 8);
        joinCodeInput.value = v;
        joinBtn.disabled = FT.Utils.parseRoomCode(v).length !== 8;
    });
    joinBtn.addEventListener('click', () => doJoinRoom(joinCodeInput.value));
    joinCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !joinBtn.disabled) doJoinRoom(joinCodeInput.value); });

    async function doJoinRoom(code) {
        try {
            joinBtn.disabled = true; joinBtn.textContent = '⏳';
            conn = new FT.ConnectionManager();
            const userCode = await conn.joinRoom(code);
            transfer = new FT.TransferManager(conn);
            wireAll();
            enterRoom(userCode);
            toast('Joined room!', 'success');
        } catch (err) {
            toast('Failed: ' + err.message, 'error'); conn = null;
        } finally {
            joinBtn.disabled = false; joinBtn.textContent = 'Join';
        }
    }

    // ═══════════ ROOM ═══════════
    function enterRoom(userCode) {
        showScreen('room');
        roomCodeText.textContent = FT.Utils.formatRoomCode(userCode);
        const link = conn.getShareLink();
        roomLinkText.textContent = link; roomLinkText.title = link;
        FT.QR.render(qrCanvas, link, 180);
        peersCountNum.textContent = '0';
        peersList.innerHTML = '<div class="peer-empty">Waiting for peer to join...</div>';
        resetTransferUI();
        window.location.hash = userCode;
    }

    function resetTransferUI() {
        queuedSection.style.display = 'none';
        activeTransferSection.style.display = 'none';
        waitingSection.style.display = 'none';
        completedSection.style.display = 'none';
        queuedList.innerHTML = '';
        completedList.innerHTML = '';
    }

    async function leaveRoom() {
        if (transfer) { transfer._killed = true; transfer = null; }
        if (conn) { await conn.leaveRoom(); conn = null; }
        window.location.hash = '';
        showScreen('dashboard');
        toast('Left the room.', 'info');
        updateSystemLoad();
    }

    backBtn.addEventListener('click', leaveRoom);
    leaveRoomBtn.addEventListener('click', leaveRoom);

    // ═══════════ COPY ═══════════
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.copy;
            let text = '';
            if (type === 'code' && conn) text = conn.getUserCode();
            if (type === 'link' && conn) text = conn.getShareLink();
            navigator.clipboard.writeText(text).then(() => {
                btn.classList.add('copied');
                toast('Copied!', 'success', 2000);
                setTimeout(() => btn.classList.remove('copied'), 2000);
            });
        });
    });

    // ═══════════ DROP ZONE ═══════════
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault(); dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => { if (fileInput.files.length > 0) { handleFiles(fileInput.files); fileInput.value = ''; } });
    function handleFiles(files) { if (transfer) transfer.addFiles(Array.from(files)); }

    // ═══════════ SEND ═══════════
    sendAllBtn.addEventListener('click', async () => {
        if (!transfer) return;
        sendAllBtn.disabled = true;
        try { await transfer.requestSendAll(); } catch (err) { toast('Error: ' + err.message, 'error'); }
    });
    clearQueueBtn.addEventListener('click', () => { if (transfer) transfer.clearQueue(); });

    // ═══════════ KILL ═══════════
    killTransferBtn.addEventListener('click', () => { if (transfer) transfer.killTransfer('Stopped by user'); });
    cancelWaitingBtn.addEventListener('click', () => {
        if (transfer) transfer.killTransfer('Cancelled by sender');
        waitingSection.style.display = 'none';
    });

    // ═══════════ MODALS ═══════════
    modalAcceptBtn.addEventListener('click', () => {
        transferModal.style.display = 'none';
        if (transfer) transfer.acceptTransfer();
    });
    modalDenyBtn.addEventListener('click', () => {
        transferModal.style.display = 'none';
        if (transfer) transfer.denyTransfer('Declined by receiver');
    });
    peerLeftOkBtn.addEventListener('click', async () => {
        peerLeftModal.style.display = 'none';
        await leaveRoom();
    });

    // ═══════════ WIRE EVENTS ═══════════
    function wireAll() { wireConnectionEvents(); wireTransferEvents(); }

    function wireConnectionEvents() {
        conn.on('peerJoining', () => updatePeersUI());
        conn.on('peerConnected', ({ name }) => { toast(`${name} connected!`, 'success'); updatePeersUI(); updateSendButton(); });
        conn.on('peerLeft', ({ name }) => { toast(`${name} disconnected.`, 'warning'); updatePeersUI(); updateSendButton(); });
        conn.on('dataChannelOpen', () => { updatePeersUI(); updateSendButton(); });
        conn.on('dataChannelClose', () => { updatePeersUI(); updateSendButton(); });
    }

    function updatePeersUI() {
        if (!conn) return;
        const peers = conn.getPeersList();
        peersCountNum.textContent = peers.length;
        if (peers.length === 0) { peersList.innerHTML = '<div class="peer-empty">Waiting for peer to join...</div>'; return; }
        peersList.innerHTML = peers.map(p => {
            const i = (p.name || 'P').slice(0, 2).toUpperCase();
            return `<div class="peer-item"><div class="peer-avatar">${i}</div><span class="peer-name">${esc(p.name)}</span><span class="peer-status ${p.status === 'connected' ? '' : 'connecting'}"></span></div>`;
        }).join('');
    }

    function updateSendButton() {
        if (!conn || !transfer) return;
        sendAllBtn.disabled = !(conn.getConnectedPeerIds().length > 0 && transfer.queuedFiles.length > 0);
    }

    // ═══════════ TRANSFER EVENTS ═══════════
    function wireTransferEvents() {
        // Queue
        transfer.on('queueUpdated', (files) => {
            if (files.length === 0) { queuedSection.style.display = 'none'; queuedList.innerHTML = ''; }
            else {
                queuedSection.style.display = 'block';
                queuedList.innerHTML = files.map((f, idx) => {
                    const icon = FT.Utils.getFileIcon(f.type, f.name);
                    return `<div class="queued-file-item"><span class="queue-order">${idx + 1}</span><div class="file-icon ${icon.cls}">${icon.emoji}</div><div class="file-info"><div class="file-name" title="${esc(f.name)}">${esc(f.name)}</div><div class="file-meta"><span>${FT.Utils.formatSize(f.size)}</span></div></div><button class="file-remove" data-remove-id="${f.id}">✕</button></div>`;
                }).join('');
                queuedList.querySelectorAll('.file-remove').forEach(b => b.addEventListener('click', () => transfer.removeFromQueue(b.dataset.removeId)));
            }
            updateSendButton();
        });

        // Sender: waiting for receiver
        transfer.on('transferRequested', () => {
            queuedSection.style.display = 'none';
            waitingSection.style.display = 'block';
            $('waiting-details').textContent = `${transfer.sendQueue.length} files ready. Waiting for receiver to accept.`;
        });

        // Sender: denied
        transfer.on('transferDenied', ({ reason }) => {
            waitingSection.style.display = 'none';
            toast('❌ Transfer denied: ' + reason, 'error', 6000);
            sendAllBtn.disabled = false;
        });

        // Receiver: incoming request → show modal
        transfer.on('transferRequest', ({ senderName, files, totalSize, totalFiles }) => {
            $('modal-title').textContent = `📨 Incoming Transfer from ${senderName}`;
            $('modal-subtitle').textContent = `${totalFiles} file${totalFiles > 1 ? 's' : ''} — ${FT.Utils.formatSize(totalSize)} total`;
            const listHtml = files.slice(0, 10).map(f => {
                const icon = FT.Utils.getFileIcon(f.type, f.name);
                return `<div class="modal-file-item"><span>${icon.emoji}</span> <span>${esc(f.name)}</span> <span class="modal-file-size">${FT.Utils.formatSize(f.size)}</span></div>`;
            }).join('');
            $('modal-file-list').innerHTML = listHtml + (files.length > 10 ? `<div class="modal-more">...and ${files.length - 10} more</div>` : '');
            $('modal-summary').textContent = `Files sent smallest first, one at a time.`;
            transferModal.style.display = 'flex';
        });

        // Receiver: accepted
        transfer.on('transferAccepted', ({ savingToFolder }) => {
            toast(savingToFolder ? '📂 Saving to selected folder' : '📥 Files will auto-download', 'info', 5000);
        });
        transfer.on('folderSelected', ({ folderName }) => toast(`📂 Saving to: ${folderName}`, 'success'));
        transfer.on('folderSkipped', () => toast('📥 No folder selected — files auto-download', 'info'));

        // Progress
        transfer.on('sendStart', ({ fileName, fileSize, fileIndex, totalFiles }) => {
            waitingSection.style.display = 'none';
            showFileTransfer('📤 Sending', fileName, fileSize, fileIndex, totalFiles);
        });
        transfer.on('receiveStart', ({ fileName, fileSize, fileIndex, totalFiles }) => {
            showFileTransfer('📥 Receiving', fileName, fileSize, fileIndex, totalFiles);
        });
        transfer.on('fileProgress', ({ progress, speed, fileIndex, totalFiles }) => {
            const pct = Math.round(progress * 100);
            $('transfer-progress-bar').style.width = pct + '%';
            $('transfer-percent').textContent = pct + '%';
            $('transfer-speed').textContent = FT.Utils.formatSpeed(speed);
            const total = transfer.activeSend ? transfer.activeSend.fileSize : (transfer.activeReceive ? transfer.activeReceive.fileSize : 0);
            const done = Math.round(total * progress);
            $('transfer-file-meta').textContent = `${FT.Utils.formatSize(done)} / ${FT.Utils.formatSize(total)}`;
            if (speed > 0) $('transfer-eta').textContent = FT.Utils.formatTime((total - done) / speed);
        });

        // File complete
        transfer.on('fileSendComplete', ({ fileName, fileSize, fileIndex, totalFiles }) => {
            addCompletedItem('📤', fileName, fileSize);
            $('overall-files-done').textContent = fileIndex;
            if (fileIndex < totalFiles) toast(`✅ Sent "${fileName}" (${fileIndex}/${totalFiles})`, 'success', 3000);
        });
        transfer.on('fileReceiveComplete', ({ fileName, fileSize, fileIndex, totalFiles, savedToDisk }) => {
            addCompletedItem(savedToDisk ? '💾' : '⬇️', fileName, fileSize);
            $('overall-files-done').textContent = fileIndex;
            toast(`✅ ${savedToDisk ? 'Saved' : 'Downloaded'} "${fileName}" (${fileIndex}/${totalFiles})`, 'success', 3000);
        });

        // All done
        transfer.on('allSendComplete', () => {
            activeTransferSection.style.display = 'none';
            toast('🎉 All files sent!', 'success', 6000);
            sendAllBtn.disabled = false;
        });
        transfer.on('allReceiveComplete', () => {
            activeTransferSection.style.display = 'none';
            toast('🎉 All files received!', 'success', 6000);
        });

        // Errors
        transfer.on('sendError', ({ error, fileName }) => {
            toast(`❌ Send failed${fileName ? ': ' + fileName : ''}: ${error}`, 'error');
            activeTransferSection.style.display = 'none';
            sendAllBtn.disabled = false;
        });
        transfer.on('receiveError', ({ error }) => {
            toast(`❌ Receive error: ${error}`, 'error');
            activeTransferSection.style.display = 'none';
        });

        // Kill
        transfer.on('transferKilled', ({ reason, byMe }) => {
            activeTransferSection.style.display = 'none';
            waitingSection.style.display = 'none';
            toast(`⛔ Transfer stopped: ${reason}`, byMe ? 'warning' : 'error', 5000);
            sendAllBtn.disabled = false;
        });

        // Peer left → always show modal (1:1 only now)
        transfer.on('peerLeftRoom', ({ name, message }) => {
            $('peer-left-title').textContent = `${name} Left`;
            $('peer-left-message').textContent = message;
            peerLeftModal.style.display = 'flex';
            activeTransferSection.style.display = 'none';
            waitingSection.style.display = 'none';
        });

        transfer.on('transferQueued', ({ fileName, queuePosition }) => {
            toast(`⏳ "${fileName}" queued #${queuePosition}`, 'warning', 5000);
        });
    }

    // ═══════════ UI HELPERS ═══════════
    function showFileTransfer(label, fileName, fileSize, fileIndex, totalFiles) {
        activeTransferSection.style.display = 'block';
        $('transfer-status-title').textContent = `${label} (${fileIndex}/${totalFiles})`;
        const icon = FT.Utils.getFileIcon('', fileName);
        $('transfer-file-icon').textContent = icon.emoji;
        $('transfer-file-name').textContent = fileName;
        $('transfer-file-meta').textContent = `0 B / ${FT.Utils.formatSize(fileSize)}`;
        $('transfer-file-counter').textContent = `${fileIndex} / ${totalFiles}`;
        $('transfer-progress-bar').style.width = '0%';
        $('transfer-percent').textContent = '0%';
        $('transfer-speed').textContent = 'Starting...';
        $('transfer-eta').textContent = '--:--';
        if (totalFiles > 1) {
            $('overall-progress').style.display = 'block';
            $('overall-files-done').textContent = fileIndex - 1;
            $('overall-files-total').textContent = totalFiles;
        } else {
            $('overall-progress').style.display = 'none';
        }
        completedSection.style.display = completedList.children.length > 0 ? 'block' : 'none';
    }

    function addCompletedItem(emoji, fileName, fileSize) {
        completedSection.style.display = 'block';
        completedList.insertAdjacentHTML('beforeend',
            `<div class="completed-item"><span>${emoji}</span> <span class="completed-name">${esc(fileName)}</span> <span class="completed-size">${FT.Utils.formatSize(fileSize)}</span> <span class="completed-check">✓</span></div>`
        );
    }

    // ═══════════ HASH JOIN ═══════════
    function checkHashForJoin() {
        const hash = window.location.hash.replace('#', '').trim();
        if (hash && hash.length >= 8) {
            const code = FT.Utils.parseRoomCode(hash);
            if (code.length === 8) doJoinRoom(code);
        }
    }
    window.addEventListener('hashchange', () => { if (currentScreen === 'dashboard') checkHashForJoin(); });

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    // ═══════════ INIT ═══════════
    function init() {
        showScreen('dashboard');
        updateSystemLoad();
        setInterval(updateSystemLoad, 30000);
        checkHashForJoin();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
