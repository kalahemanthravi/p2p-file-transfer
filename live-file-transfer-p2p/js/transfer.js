/* ═══════════════════════════════════════════════════════════
   FridayTransfer — Intelligent Transfer Manager v2
   NO THROTTLING — File data goes P2P via WebRTC, never Supabase
   DB used ONLY for lightweight tracking, not speed control
   ═══════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    window.FT = window.FT || {};

    class TransferManager extends FT.EventEmitter {
        constructor(connectionManager) {
            super();
            this.conn = connectionManager;
            this.queuedFiles = [];
            this.activeSend = null;
            this.activeReceive = null;
            this.sendQueue = [];
            this.isSending = false;
            this.isReceiving = false;
            this._killed = false;
            this._receiverDirHandle = null;
            this._pendingRequest = null;

            this._setupListeners();
        }

        _setupListeners() {
            this.conn.on('dataChannelMessage', ({ peerId, data }) => {
                this._handleMessage(peerId, data);
            });
            this.conn.on('peerLeft', ({ peerId, name }) => {
                this._handlePeerLeft(peerId, name);
            });
        }

        // ═══════════════════════════════════════════════
        //  QUEUE MANAGEMENT
        // ═══════════════════════════════════════════════

        addFiles(files) {
            for (const file of files) {
                this.queuedFiles.push({
                    id: FT.Utils.generateId(10),
                    file, name: file.name, size: file.size, type: file.type,
                });
            }
            this.queuedFiles.sort((a, b) => a.size - b.size);
            this.emit('queueUpdated', this.queuedFiles);
        }

        removeFromQueue(fileId) {
            this.queuedFiles = this.queuedFiles.filter(f => f.id !== fileId);
            this.queuedFiles.sort((a, b) => a.size - b.size);
            this.emit('queueUpdated', this.queuedFiles);
        }

        clearQueue() {
            this.queuedFiles = [];
            this.emit('queueUpdated', this.queuedFiles);
        }

        // ═══════════════════════════════════════════════
        //  SENDER: Request Transfer
        // ═══════════════════════════════════════════════

        async requestSendAll() {
            const peerIds = this.conn.getConnectedPeerIds();
            if (peerIds.length === 0) return this.emit('sendError', { error: 'No connected peers' });
            if (this.queuedFiles.length === 0) return this.emit('sendError', { error: 'No files selected' });

            this.queuedFiles.sort((a, b) => a.size - b.size);
            this.sendQueue = [...this.queuedFiles];
            this.queuedFiles = [];
            this.emit('queueUpdated', this.queuedFiles);

            const fileList = this.sendQueue.map(f => ({ name: f.name, size: f.size, type: f.type }));
            const totalSize = this.sendQueue.reduce((s, f) => s + f.size, 0);

            const key = this.conn.encryptionKey;
            const msg = { _ft: 'TRANSFER_REQUEST', senderName: this.conn.peerName, files: fileList, totalSize, totalFiles: fileList.length };
            const enc = await FT.Crypto.encryptMessage(key, msg);
            const payload = JSON.stringify({ _ft_enc: enc });
            for (const pid of peerIds) this.conn.sendToPeer(pid, payload);

            this.emit('transferRequested', { files: fileList, totalSize, totalFiles: fileList.length, peerIds });
        }

        // ═══════════════════════════════════════════════
        //  SENDER: Sequential File Sending (FULL SPEED)
        // ═══════════════════════════════════════════════

        async _startSendingSequence(peerId) {
            if (this.isSending || this.sendQueue.length === 0) return;
            this.isSending = true;
            this._killed = false;

            const totalFiles = this.sendQueue.length;
            let fileIndex = 0;

            // Register all files in DB in one batch (lightweight, fire-and-forget)
            this._dbRegisterBatch(totalFiles);

            while (this.sendQueue.length > 0 && !this._killed) {
                const qf = this.sendQueue[0];
                fileIndex++;

                try {
                    await this._sendSingleFile(qf.file, peerId, fileIndex, totalFiles);
                    this.sendQueue.shift();
                } catch (err) {
                    if (this._killed) break;
                    this.emit('sendError', { transferId: this.activeSend?.transferId, error: err.message, fileName: qf.name });
                    break;
                }
            }

            this.isSending = false;
            if (!this._killed && this.sendQueue.length === 0) {
                const key = this.conn.encryptionKey;
                const enc = await FT.Crypto.encryptMessage(key, { _ft: 'ALL_TRANSFERS_DONE' });
                this.conn.sendToPeer(peerId, JSON.stringify({ _ft_enc: enc }));
                this.emit('allSendComplete');
            }

            // Cleanup DB records (fire-and-forget)
            this._dbCleanup();
        }

        async _sendSingleFile(file, peerId, fileIndex, totalFiles) {
            const transferId = FT.Utils.generateId(12);
            const totalChunks = Math.ceil(file.size / FT.CHUNK_SIZE);
            const key = this.conn.encryptionKey;

            this.activeSend = {
                transferId, peerId,
                fileName: file.name, fileSize: file.size,
                totalChunks, sentChunks: 0,
                startTime: Date.now(), lastTime: Date.now(), lastBytes: 0, speed: 0,
                aborted: false,
            };

            this.emit('sendStart', {
                transferId, fileName: file.name, fileSize: file.size,
                totalChunks, peerId, fileIndex, totalFiles,
            });

            // 1) FILE_META
            const metaMsg = {
                _ft: 'FILE_META', transferId,
                fileName: file.name, fileSize: file.size,
                fileType: file.type || 'application/octet-stream',
                totalChunks, fileIndex, totalFiles,
            };
            const encMeta = await FT.Crypto.encryptMessage(key, metaMsg);
            this.conn.sendToPeer(peerId, JSON.stringify({ _ft_enc: encMeta }));

            // 2) SEND ALL CHUNKS — FULL SPEED, NO THROTTLE
            for (let i = 0; i < totalChunks; i++) {
                if (this.activeSend.aborted || this._killed) throw new Error('Transfer killed');

                const start = i * FT.CHUNK_SIZE;
                const end = Math.min(start + FT.CHUNK_SIZE, file.size);
                const buffer = await file.slice(start, end).arrayBuffer();
                const encrypted = await FT.Crypto.encrypt(key, buffer);

                // Build packet header
                const tidBytes = new TextEncoder().encode(transferId);
                const header = new Uint8Array(4 + tidBytes.length + 4);
                new DataView(header.buffer).setUint32(0, tidBytes.length);
                header.set(tidBytes, 4);
                new DataView(header.buffer).setUint32(4 + tidBytes.length, i);
                const packet = new Uint8Array(header.length + encrypted.length);
                packet.set(header, 0);
                packet.set(encrypted, header.length);

                // Only flow control: wait for WebRTC buffer (backpressure)
                await this.conn.waitForBuffer(peerId);

                this.conn.sendToPeer(peerId, packet.buffer);

                // Progress tracking (UI only, no DB writes)
                this.activeSend.sentChunks = i + 1;
                const now = Date.now();
                const elapsed = (now - this.activeSend.lastTime) / 1000;
                if (elapsed > 0.25) {
                    const bytesSent = this.activeSend.sentChunks * FT.CHUNK_SIZE;
                    this.activeSend.speed = (bytesSent - this.activeSend.lastBytes) / elapsed;
                    this.activeSend.lastBytes = bytesSent;
                    this.activeSend.lastTime = now;
                }

                this.emit('fileProgress', {
                    transferId,
                    progress: this.activeSend.sentChunks / totalChunks,
                    speed: this.activeSend.speed,
                    fileName: file.name,
                    sentChunks: this.activeSend.sentChunks,
                    totalChunks, fileIndex, totalFiles,
                });
            }

            // 3) FILE_DONE
            const encDone = await FT.Crypto.encryptMessage(key, { _ft: 'FILE_DONE', transferId });
            this.conn.sendToPeer(peerId, JSON.stringify({ _ft_enc: encDone }));

            this.emit('fileSendComplete', {
                transferId, fileName: file.name, fileSize: file.size, fileIndex, totalFiles,
            });

            this.activeSend = null;
        }

        // ═══════════════════════════════════════════════
        //  RECEIVER: Handle Messages
        // ═══════════════════════════════════════════════

        async _handleMessage(peerId, data) {
            try {
                if (typeof data === 'string') {
                    const parsed = JSON.parse(data);
                    if (parsed._ft_enc) {
                        const msg = await FT.Crypto.decryptMessage(this.conn.encryptionKey, parsed._ft_enc);
                        await this._handleControlMessage(peerId, msg);
                    }
                } else if (data instanceof ArrayBuffer) {
                    await this._handleChunk(peerId, data);
                }
            } catch (err) {
                console.error('[Transfer] Message error:', err);
            }
        }

        async _handleControlMessage(peerId, msg) {
            switch (msg._ft) {
                case 'TRANSFER_REQUEST': this._handleTransferRequest(peerId, msg); break;
                case 'TRANSFER_ACCEPTED': this._startSendingSequence(peerId); break;
                case 'TRANSFER_DENIED':
                    this.sendQueue = [];
                    this.isSending = false;
                    this.emit('transferDenied', { peerId, reason: msg.reason || 'Declined' });
                    break;
                case 'FILE_META': this._handleFileMeta(peerId, msg); break;
                case 'FILE_DONE': await this._handleFileDone(msg); break;
                case 'ALL_TRANSFERS_DONE':
                    this.isReceiving = false;
                    this.emit('allReceiveComplete');
                    this._dbCleanup();
                    break;
                case 'KILL_TRANSFER': this._handleKillFromPeer(peerId, msg); break;
            }
        }

        _handleTransferRequest(peerId, msg) {
            this._pendingRequest = {
                peerId, senderName: msg.senderName,
                files: msg.files, totalSize: msg.totalSize, totalFiles: msg.totalFiles,
            };
            this.emit('transferRequest', this._pendingRequest);
        }

        async acceptTransfer() {
            if (!this._pendingRequest) return;
            const req = this._pendingRequest;
            this._pendingRequest = null;
            this.isReceiving = true;
            this._killed = false;

            // Folder picker
            if ('showDirectoryPicker' in window) {
                try {
                    this._receiverDirHandle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
                    this.emit('folderSelected', { folderName: this._receiverDirHandle.name });
                } catch (e) {
                    this._receiverDirHandle = null;
                    this.emit('folderSkipped');
                }
            }

            const key = this.conn.encryptionKey;
            const enc = await FT.Crypto.encryptMessage(key, { _ft: 'TRANSFER_ACCEPTED' });
            this.conn.sendToPeer(req.peerId, JSON.stringify({ _ft_enc: enc }));
            this.emit('transferAccepted', { senderName: req.senderName, totalFiles: req.totalFiles, totalSize: req.totalSize, savingToFolder: !!this._receiverDirHandle });
        }

        async denyTransfer(reason) {
            if (!this._pendingRequest) return;
            const req = this._pendingRequest;
            this._pendingRequest = null;
            const enc = await FT.Crypto.encryptMessage(this.conn.encryptionKey, { _ft: 'TRANSFER_DENIED', reason: reason || 'Declined' });
            this.conn.sendToPeer(req.peerId, JSON.stringify({ _ft_enc: enc }));
            this.emit('transferDeniedByMe', { senderName: req.senderName });
        }

        _handleFileMeta(peerId, msg) {
            this.activeReceive = {
                transferId: msg.transferId, peerId,
                fileName: msg.fileName, fileSize: msg.fileSize,
                fileType: msg.fileType, totalChunks: msg.totalChunks,
                fileIndex: msg.fileIndex, totalFiles: msg.totalFiles,
                receivedChunks: 0, chunks: new Array(msg.totalChunks),
                startTime: Date.now(), lastTime: Date.now(), lastBytes: 0, speed: 0,
                writableStream: null,
            };
            this._openFileForWriting(this.activeReceive);
            this.emit('receiveStart', {
                transferId: msg.transferId, fileName: msg.fileName,
                fileSize: msg.fileSize, fileIndex: msg.fileIndex, totalFiles: msg.totalFiles,
            });
        }

        async _openFileForWriting(state) {
            if (!this._receiverDirHandle) return;
            try {
                const fh = await this._receiverDirHandle.getFileHandle(state.fileName, { create: true });
                state.writableStream = await fh.createWritable();
            } catch (e) {
                state.writableStream = null;
            }
        }

        async _handleChunk(peerId, data) {
            const view = new DataView(data);
            const tidLen = view.getUint32(0);
            const tidBytes = new Uint8Array(data, 4, tidLen);
            const transferId = new TextDecoder().decode(tidBytes);
            const chunkIndex = view.getUint32(4 + tidLen);
            const encryptedData = new Uint8Array(data, 4 + tidLen + 4);

            const state = this.activeReceive;
            if (!state || state.transferId !== transferId) return;

            const decrypted = await FT.Crypto.decrypt(this.conn.encryptionKey, encryptedData);

            if (state.writableStream) {
                try { await state.writableStream.write(new Uint8Array(decrypted)); }
                catch (e) { state.writableStream = null; state.chunks[chunkIndex] = new Uint8Array(decrypted); }
            } else {
                state.chunks[chunkIndex] = new Uint8Array(decrypted);
            }

            state.receivedChunks++;
            const now = Date.now();
            const elapsed = (now - state.lastTime) / 1000;
            if (elapsed > 0.25) {
                const b = state.receivedChunks * FT.CHUNK_SIZE;
                state.speed = (b - state.lastBytes) / elapsed;
                state.lastBytes = b;
                state.lastTime = now;
            }

            this.emit('fileProgress', {
                transferId,
                progress: state.receivedChunks / state.totalChunks,
                speed: state.speed, fileName: state.fileName,
                receivedChunks: state.receivedChunks, totalChunks: state.totalChunks,
                fileIndex: state.fileIndex, totalFiles: state.totalFiles,
            });
        }

        async _handleFileDone(msg) {
            const state = this.activeReceive;
            if (!state || state.transferId !== msg.transferId) return;

            try {
                if (state.writableStream) {
                    await state.writableStream.close();
                    this.emit('fileReceiveComplete', {
                        transferId: state.transferId, fileName: state.fileName,
                        fileSize: state.fileSize, fileIndex: state.fileIndex,
                        totalFiles: state.totalFiles, savedToDisk: true,
                    });
                } else {
                    const parts = [];
                    for (let i = 0; i < state.totalChunks; i++) if (state.chunks[i]) parts.push(state.chunks[i]);
                    const blob = new Blob(parts, { type: state.fileType || 'application/octet-stream' });
                    const url = URL.createObjectURL(blob);
                    this.emit('fileReceiveComplete', {
                        transferId: state.transferId, fileName: state.fileName,
                        fileSize: state.fileSize, fileIndex: state.fileIndex,
                        totalFiles: state.totalFiles, savedToDisk: false, downloadUrl: url,
                    });
                    // Auto-download
                    const a = document.createElement('a');
                    a.href = url; a.download = state.fileName;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(url), 60000);
                }
            } catch (err) {
                this.emit('receiveError', { transferId: state.transferId, error: err.message });
            }

            // Free memory immediately
            if (state.chunks) state.chunks = null;
            this.activeReceive = null;
        }

        // ═══════════════════════════════════════════════
        //  KILL: Cancel from either side
        // ═══════════════════════════════════════════════

        async killTransfer(reason) {
            this._killed = true;
            reason = reason || 'Transfer cancelled';
            if (this.activeSend) this.activeSend.aborted = true;
            if (this.activeReceive) {
                if (this.activeReceive.writableStream) try { await this.activeReceive.writableStream.abort(); } catch (e) { }
                if (this.activeReceive.chunks) this.activeReceive.chunks = null;
                this.activeReceive = null;
            }
            this.sendQueue = [];
            this.isSending = false;
            this.isReceiving = false;

            const enc = await FT.Crypto.encryptMessage(this.conn.encryptionKey, { _ft: 'KILL_TRANSFER', reason });
            const payload = JSON.stringify({ _ft_enc: enc });
            for (const pid of this.conn.getConnectedPeerIds()) this.conn.sendToPeer(pid, payload);

            this.emit('transferKilled', { reason, byMe: true });
            this._dbCleanup();
        }

        _handleKillFromPeer(peerId, msg) {
            this._killed = true;
            if (this.activeSend) this.activeSend.aborted = true;
            if (this.activeReceive) {
                if (this.activeReceive.writableStream) try { this.activeReceive.writableStream.abort(); } catch (e) { }
                if (this.activeReceive.chunks) this.activeReceive.chunks = null;
                this.activeReceive = null;
            }
            this.sendQueue = [];
            this.isSending = false;
            this.isReceiving = false;
            this.emit('transferKilled', { reason: msg.reason || 'Cancelled by other party', byMe: false, peerId });
            this._dbCleanup();
        }

        // ═══════════════════════════════════════════════
        //  PEER LEFT
        // ═══════════════════════════════════════════════

        _handlePeerLeft(peerId, name) {
            // 1:1 only — everything stops when peer leaves
            this._killed = true;
            if (this.activeSend) this.activeSend.aborted = true;
            if (this.activeReceive) {
                if (this.activeReceive.writableStream) try { this.activeReceive.writableStream.abort(); } catch (e) { }
                this.activeReceive = null;
            }
            this.sendQueue = [];
            this.isSending = false;
            this.isReceiving = false;
            this.emit('peerLeftRoom', {
                peerId, name,
                message: `${name} has left the room. All transfers stopped.`,
                shouldLeave: true,
            });
            this._dbCleanup();
        }

        // ═══════════════════════════════════════════════
        //  LIGHTWEIGHT DB (fire-and-forget, no blocking)
        // ═══════════════════════════════════════════════

        _dbRegisterBatch(totalFiles) {
            // Fire-and-forget: just update the counter, don't block transfers
            if (!this.conn.supabase) return;
            this.conn.supabase.from('system_stats').update({
                active_transfers: totalFiles
            }).eq('id', 1).then(() => { }).catch(() => { });
        }

        _dbCleanup() {
            if (!this.conn.supabase || !this.conn.roomDbId) return;
            // Fire-and-forget cleanup
            this.conn.supabase.from('transfers').delete()
                .eq('room_id', this.conn.roomDbId)
                .in('status', ['completed', 'cancelled', 'failed'])
                .then(() => { }).catch(() => { });
            this.conn.supabase.from('signals').delete()
                .eq('room_code', this.conn.roomCode)
                .then(() => { }).catch(() => { });
        }

        downloadFile(transferId) { /* auto-download is default */ }
    }

    FT.TransferManager = TransferManager;
})();
