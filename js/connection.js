/* ═══════════════════════════════════════════════════════════
   FridayTransfer — Connection Manager (Database-Backed)
   Supabase DB for room/peer tracking + Realtime for signaling
   ═══════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    window.FT = window.FT || {};

    class ConnectionManager extends FT.EventEmitter {
        constructor() {
            super();
            this.supabase = null;
            this.channel = null;
            this.signalSubscription = null;
            this.peerId = FT.Utils.generatePeerId();
            this.peerName = 'User-' + this.peerId.slice(-4);
            this.roomCode = null;   // derived room ID (hash of user code)
            this.roomDbId = null;    // UUID from database
            this.encryptionKey = null;
            this.mode = 'pair';
            this.peers = new Map();
            this.isHost = false;
            this._heartbeatTimer = null;
            this._cleanupTimer = null;
            this._signalPollTimer = null;
            this._destroyed = false;
            this._capacity = null;

            this._boundBeforeUnload = this._onBeforeUnload.bind(this);
            this._boundPageHide = this._onPageHide.bind(this);
            window.addEventListener('beforeunload', this._boundBeforeUnload);
            window.addEventListener('pagehide', this._boundPageHide);
        }

        /** Initialize Supabase client */
        initSupabase() {
            if (this.supabase) return;
            this.supabase = window.supabase.createClient(FT.SUPABASE_URL, FT.SUPABASE_ANON_KEY, {
                realtime: { params: { eventsPerSecond: 10 } }
            });
        }

        /** Get system capacity */
        async getCapacity() {
            this.initSupabase();
            const { data, error } = await this.supabase.rpc('get_system_capacity');
            if (error) throw new Error('Failed to check capacity: ' + error.message);
            this._capacity = data;
            return data;
        }

        /** Create a new room (with DB registration) */
        async createRoom() {
            this.initSupabase();
            this.mode = 'pair';
            this.isHost = true;

            // Generate room code and derive crypto
            const userCode = FT.Utils.generateId(8);
            this.roomCode = await FT.Crypto.deriveRoomId(userCode);
            this.encryptionKey = await FT.Crypto.deriveEncryptionKey(userCode);
            this._userCode = userCode; // store for sharing

            // Register room in database (with capacity check)
            const { data, error } = await this.supabase.rpc('create_room', {
                p_room_code: this.roomCode,
                p_mode: 'pair',
                p_host_peer_id: this.peerId
            });

            if (error) throw new Error('DB error: ' + error.message);
            if (data.error) throw new Error(data.error);

            this.roomDbId = data.room_id;
            this._capacity = data.capacity;

            // Join as peer in DB
            await this._dbJoinRoom();

            // Subscribe to signaling
            await this._subscribeSignals();

            // Start heartbeat & cleanup
            this._startHeartbeat();
            this._startCleanup();

            return userCode;
        }

        /** Join an existing room by user code */
        async joinRoom(code) {
            this.initSupabase();
            const userCode = FT.Utils.parseRoomCode(code);
            if (userCode.length !== 8) throw new Error('Invalid room code');

            this.roomCode = await FT.Crypto.deriveRoomId(userCode);
            this.encryptionKey = await FT.Crypto.deriveEncryptionKey(userCode);
            this._userCode = userCode;

            // Join room in DB (with capacity check)
            const { data, error } = await this.supabase.rpc('join_room', {
                p_room_code: this.roomCode,
                p_peer_id: this.peerId,
                p_peer_name: this.peerName
            });

            if (error) throw new Error('DB error: ' + error.message);
            if (data.error) throw new Error(data.error);

            this.roomDbId = data.room_id;
            this.mode = 'pair';

            // Subscribe to signaling
            await this._subscribeSignals();

            // Load existing peers and connect
            await this._loadExistingPeers();

            // Start heartbeat & cleanup
            this._startHeartbeat();
            this._startCleanup();

            return userCode;
        }

        /** Register self as peer in DB */
        async _dbJoinRoom() {
            const { error } = await this.supabase.rpc('join_room', {
                p_room_code: this.roomCode,
                p_peer_id: this.peerId,
                p_peer_name: this.peerName
            });
            if (error) console.error('[DB] Join room error:', error);
        }

        /** Load existing peers from DB and initiate connections */
        async _loadExistingPeers() {
            const { data: peers, error } = await this.supabase
                .from('peers')
                .select('peer_id, peer_name')
                .eq('room_id', this.roomDbId)
                .eq('is_active', true)
                .neq('peer_id', this.peerId);

            if (error || !peers) return;

            for (const p of peers) {
                if (this.peers.size >= 1) break; // 1:1 only
                // Peer with smaller ID creates the offer
                if (this.peerId < p.peer_id) {
                    this._initiateConnection(p.peer_id, p.peer_name);
                }
                this.emit('peerJoining', { peerId: p.peer_id, name: p.peer_name });
            }
        }

        /** Subscribe to signaling via Supabase Realtime (Postgres Changes on signals table) */
        async _subscribeSignals() {
            const channelName = `signals-${this.roomCode}`;

            this.channel = this.supabase.channel(channelName, {
                config: { broadcast: { self: false } }
            });

            // Listen for broadcast signals (fast path)
            this.channel.on('broadcast', { event: 'signal' }, (payload) => {
                this._handleSignal(payload.payload);
            });

            // Listen for new peers joining via Postgres Changes
            this.channel.on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'peers',
                filter: `room_id=eq.${this.roomDbId}`
            }, (payload) => {
                const newPeer = payload.new;
                if (newPeer.peer_id === this.peerId || !newPeer.is_active) return;
                this._handleNewPeerFromDB(newPeer);
            });

            // Listen for peers leaving
            this.channel.on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'peers',
                filter: `room_id=eq.${this.roomDbId}`
            }, (payload) => {
                const updated = payload.new;
                if (updated.peer_id === this.peerId) return;
                if (!updated.is_active) {
                    this._removePeer(updated.peer_id);
                }
            });

            await new Promise((resolve, reject) => {
                this.channel.subscribe((status) => {
                    if (status === 'SUBSCRIBED') resolve();
                    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                        reject(new Error('Channel subscribe failed: ' + status));
                    }
                });
            });

            // Also poll signals table as fallback (in case broadcast is missed)
            this._startSignalPolling();
        }

        /** Poll signals table as fallback */
        _startSignalPolling() {
            let lastSignalId = 0;
            this._signalPollTimer = setInterval(async () => {  // poll every 3s (fallback only)
                if (this._destroyed) return;
                try {
                    const { data } = await this.supabase
                        .from('signals')
                        .select('*')
                        .eq('room_code', this.roomCode)
                        .eq('to_peer', this.peerId)
                        .gt('id', lastSignalId)
                        .order('id', { ascending: true })
                        .limit(20);

                    if (data && data.length > 0) {
                        for (const sig of data) {
                            lastSignalId = sig.id;
                            this._handleSignal({
                                from: sig.from_peer,
                                to: sig.to_peer,
                                type: sig.signal_type,
                                ...sig.payload
                            });
                        }
                        // Clean up processed signals
                        await this.supabase.from('signals').delete().lte('id', lastSignalId).eq('to_peer', this.peerId);
                    }
                } catch (e) { /* ignore polling errors */ }
            }, 3000);
        }

        /** Handle new peer detected from DB */
        _handleNewPeerFromDB(peerRow) {
            const peerId = peerRow.peer_id;
            const peerName = peerRow.peer_name;

            if (this.peers.has(peerId)) return;
            if (this.peers.size >= 1) return; // 1:1 only

            // Peer with smaller ID initiates
            if (this.peerId < peerId) {
                this._initiateConnection(peerId, peerName);
            }
            this.emit('peerJoining', { peerId, name: peerName });
        }

        /** Handle signaling messages */
        async _handleSignal(payload) {
            if (!payload || payload.to !== this.peerId) return;
            const from = payload.from;
            const type = payload.type;

            try {
                switch (type) {
                    case 'offer': {
                        let peer = this.peers.get(from);
                        if (!peer) {
                            peer = this._createPeerConnection(from, payload.name || 'Peer');
                        }
                        await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                        const answer = await peer.pc.createAnswer();
                        await peer.pc.setLocalDescription(answer);
                        this._sendSignal(from, { type: 'answer', sdp: peer.pc.localDescription });
                        break;
                    }
                    case 'answer': {
                        const peer = this.peers.get(from);
                        if (peer && peer.pc.signalingState !== 'stable') {
                            await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                        }
                        break;
                    }
                    case 'ice': {
                        const peer = this.peers.get(from);
                        if (peer && payload.candidate) {
                            try { await peer.pc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (e) { }
                        }
                        break;
                    }
                    case 'bye': {
                        this._removePeer(from);
                        break;
                    }
                }
            } catch (err) {
                console.error('[Connection] Signal error:', err);
            }
        }

        /** Create WebRTC peer connection */
        _createPeerConnection(remotePeerId, remoteName) {
            const pc = new RTCPeerConnection({ iceServers: FT.ICE_SERVERS });
            const peerInfo = { pc, dataChannel: null, name: remoteName, status: 'connecting' };

            pc.onicecandidate = (e) => {
                if (e.candidate) {
                    this._sendSignal(remotePeerId, { type: 'ice', candidate: e.candidate });
                }
            };

            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                if (state === 'connected' || state === 'completed') {
                    peerInfo.status = 'connected';
                    this.emit('peerConnected', { peerId: remotePeerId, name: remoteName });
                } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                    this._removePeer(remotePeerId);
                }
            };

            pc.ondatachannel = (e) => {
                peerInfo.dataChannel = e.channel;
                this._setupDataChannel(e.channel, remotePeerId);
            };

            this.peers.set(remotePeerId, peerInfo);
            return peerInfo;
        }

        /** Initiate WebRTC connection */
        async _initiateConnection(remotePeerId, remoteName) {
            let peer = this.peers.get(remotePeerId);
            if (!peer) peer = this._createPeerConnection(remotePeerId, remoteName);

            const dc = peer.pc.createDataChannel('fridaytransfer', { ordered: true });
            peer.dataChannel = dc;
            this._setupDataChannel(dc, remotePeerId);

            const offer = await peer.pc.createOffer();
            await peer.pc.setLocalDescription(offer);
            this._sendSignal(remotePeerId, { type: 'offer', sdp: peer.pc.localDescription, name: this.peerName });
        }

        /** Setup data channel */
        _setupDataChannel(dc, remotePeerId) {
            dc.binaryType = 'arraybuffer';
            dc.bufferedAmountLowThreshold = FT.CHUNK_SIZE;

            dc.onopen = () => {
                const peer = this.peers.get(remotePeerId);
                if (peer) { peer.status = 'connected'; peer.dataChannel = dc; }
                this.emit('dataChannelOpen', { peerId: remotePeerId });
            };
            dc.onmessage = (e) => {
                this.emit('dataChannelMessage', { peerId: remotePeerId, data: e.data });
            };
            dc.onclose = () => { this.emit('dataChannelClose', { peerId: remotePeerId }); };
            dc.onerror = (e) => { console.error('[DataChannel] Error:', remotePeerId, e); };
        }

        /** Send signal via Broadcast + DB fallback */
        _sendSignal(toPeerId, payload) {
            if (!this.channel) return;

            const msg = { from: this.peerId, to: toPeerId, ...payload };

            // Fast path: broadcast
            this.channel.send({ type: 'broadcast', event: 'signal', payload: msg });

            // Reliable path: write to signals table
            this.supabase.from('signals').insert({
                room_code: this.roomCode,
                from_peer: this.peerId,
                to_peer: toPeerId,
                signal_type: payload.type,
                payload: payload.type === 'ice' ? { candidate: payload.candidate } : { sdp: payload.sdp, name: payload.name }
            }).then(() => { }).catch(() => { });
        }

        /** Send data to a specific peer */
        sendToPeer(peerId, data) {
            const peer = this.peers.get(peerId);
            if (peer && peer.dataChannel && peer.dataChannel.readyState === 'open') {
                peer.dataChannel.send(data);
                return true;
            }
            return false;
        }

        sendToAll(data) {
            for (const [, peer] of this.peers) {
                if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                    peer.dataChannel.send(data);
                }
            }
        }

        getBufferedAmount(peerId) {
            const peer = this.peers.get(peerId);
            return (peer && peer.dataChannel) ? peer.dataChannel.bufferedAmount : 0;
        }

        async waitForBuffer(peerId) {
            const peer = this.peers.get(peerId);
            if (!peer || !peer.dataChannel) return;
            while (peer.dataChannel.bufferedAmount > FT.MAX_BUFFER) {
                await new Promise(resolve => {
                    const handler = () => { peer.dataChannel.removeEventListener('bufferedamountlow', handler); resolve(); };
                    peer.dataChannel.addEventListener('bufferedamountlow', handler);
                    setTimeout(resolve, 100);
                });
            }
        }

        getConnectedPeerIds() {
            const ids = [];
            for (const [id, peer] of this.peers) {
                if (peer.dataChannel && peer.dataChannel.readyState === 'open') ids.push(id);
            }
            return ids;
        }

        getPeersList() {
            const list = [];
            for (const [id, peer] of this.peers) {
                list.push({
                    peerId: id, name: peer.name, status: peer.status,
                    channelState: peer.dataChannel ? peer.dataChannel.readyState : 'none'
                });
            }
            return list;
        }

        _removePeer(peerId) {
            const peer = this.peers.get(peerId);
            if (!peer) return;
            try { if (peer.dataChannel) peer.dataChannel.close(); peer.pc.close(); } catch (e) { }
            this.peers.delete(peerId);
            this.emit('peerLeft', { peerId, name: peer.name });
        }

        /** Heartbeat: keep peer alive in DB */
        _startHeartbeat() {
            this._heartbeatTimer = setInterval(async () => {
                if (this._destroyed) return;
                try {
                    await this.supabase.rpc('peer_heartbeat', {
                        p_room_code: this.roomCode,
                        p_peer_id: this.peerId
                    });
                } catch (e) { /* ignore */ }
            }, 15000); // every 15s (was 5s)
        }

        /** Periodic cleanup of stale data */
        _startCleanup() {
            this._cleanupTimer = setInterval(async () => {
                if (this._destroyed) return;
                try {
                    await this.supabase.rpc('cleanup_stale');
                } catch (e) { /* ignore */ }
            }, 60000); // every 60s (was 15s)
        }

        _onBeforeUnload() { this._safeDisconnect(); }
        _onPageHide(e) { if (!e.persisted) this._safeDisconnect(); }

        _safeDisconnect() {
            for (const [peerId] of this.peers) {
                this._sendSignal(peerId, { type: 'bye' });
            }
            // DB cleanup via fetch keepalive (works even when page is closing)
            if (this.roomCode) {
                try {
                    fetch(`${FT.SUPABASE_URL}/rest/v1/rpc/leave_room`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'apikey': FT.SUPABASE_ANON_KEY,
                            'Authorization': `Bearer ${FT.SUPABASE_ANON_KEY}`
                        },
                        body: JSON.stringify({ p_room_code: this.roomCode, p_peer_id: this.peerId }),
                        keepalive: true
                    }).catch(() => { });
                } catch (e) { /* ignore */ }
            }
        }

        /** Leave room completely */
        async leaveRoom() {
            this._destroyed = true;
            clearInterval(this._heartbeatTimer);
            clearInterval(this._cleanupTimer);
            clearInterval(this._signalPollTimer);

            for (const [peerId] of this.peers) {
                this._sendSignal(peerId, { type: 'bye' });
            }
            for (const [peerId] of this.peers) {
                this._removePeer(peerId);
            }

            // Aggressive DB cleanup — delete all data for this peer/room
            if (this.supabase && this.roomCode) {
                try {
                    await this.supabase.rpc('leave_room', {
                        p_room_code: this.roomCode,
                        p_peer_id: this.peerId
                    });
                } catch (e) { }
                try {
                    // Delete signals for this room
                    await this.supabase.from('signals').delete().eq('room_code', this.roomCode);
                } catch (e) { }
                try {
                    // Delete completed/cancelled transfers
                    if (this.roomDbId) {
                        await this.supabase.from('transfers').delete()
                            .eq('room_id', this.roomDbId)
                            .in('status', ['completed', 'cancelled', 'failed']);
                    }
                } catch (e) { }
            }

            if (this.channel) {
                try { await this.supabase.removeChannel(this.channel); } catch (e) { }
                this.channel = null;
            }

            this.roomCode = null;
            this.roomDbId = null;
            this.encryptionKey = null;
            this.peers.clear();

            window.removeEventListener('beforeunload', this._boundBeforeUnload);
            window.removeEventListener('pagehide', this._boundPageHide);
            this.emit('roomLeft');
        }

        getShareLink() {
            return window.location.origin + window.location.pathname + '#' + this._userCode;
        }

        getUserCode() {
            return this._userCode;
        }
    }

    FT.ConnectionManager = ConnectionManager;
})();
