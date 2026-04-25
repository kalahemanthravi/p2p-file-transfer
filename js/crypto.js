/* ═══════════════════════════════════════════════════════════
   FridayTransfer — End-to-End Encryption (Web Crypto API)
   AES-GCM 256-bit encryption with HKDF key derivation
   ═══════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    window.FT = window.FT || {};

    const SALT = new TextEncoder().encode('fridaytransfer-v1-salt');
    const INFO_ENCRYPT = new TextEncoder().encode('fridaytransfer-file-encryption');
    const INFO_ROOMID = new TextEncoder().encode('fridaytransfer-room-id');

    FT.Crypto = {

        /**
         * Derive a room ID (hex string) from the room code.
         * This is used as the Supabase channel name.
         * The room code itself is never sent to the server.
         */
        async deriveRoomId(roomCode) {
            const data = new TextEncoder().encode(roomCode);
            const hash = await crypto.subtle.digest('SHA-256', data);
            const arr = new Uint8Array(hash);
            return Array.from(arr.slice(0, 12))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        },

        /**
         * Derive an AES-GCM 256-bit encryption key from the room code using HKDF.
         * The key never leaves the client.
         */
        async deriveEncryptionKey(roomCode) {
            // Import room code as HKDF key material
            const keyMaterial = await crypto.subtle.importKey(
                'raw',
                new TextEncoder().encode(roomCode),
                'HKDF',
                false,
                ['deriveKey']
            );

            // Derive AES-GCM key
            return crypto.subtle.deriveKey(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt: SALT,
                    info: INFO_ENCRYPT,
                },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        },

        /**
         * Encrypt a data chunk (Uint8Array or ArrayBuffer).
         * Returns Uint8Array with IV prepended: [12-byte IV][ciphertext]
         */
        async encrypt(key, data) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                data
            );
            const result = new Uint8Array(12 + ciphertext.byteLength);
            result.set(iv, 0);
            result.set(new Uint8Array(ciphertext), 12);
            return result;
        },

        /**
         * Decrypt data (Uint8Array or ArrayBuffer).
         * Expects IV prepended format: [12-byte IV][ciphertext]
         * Returns decrypted ArrayBuffer.
         */
        async decrypt(key, data) {
            const dataArr = data instanceof Uint8Array ? data : new Uint8Array(data);
            const iv = dataArr.slice(0, 12);
            const ciphertext = dataArr.slice(12);
            return crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                key,
                ciphertext
            );
        },

        /**
         * Encrypt a JSON control message as a string.
         * Returns base64-encoded encrypted string.
         */
        async encryptMessage(key, obj) {
            const json = JSON.stringify(obj);
            const data = new TextEncoder().encode(json);
            const encrypted = await this.encrypt(key, data);
            return this._uint8ToBase64(encrypted);
        },

        /**
         * Decrypt a base64-encoded encrypted control message.
         * Returns parsed JSON object.
         */
        async decryptMessage(key, base64Str) {
            const data = this._base64ToUint8(base64Str);
            const decrypted = await this.decrypt(key, data);
            const json = new TextDecoder().decode(decrypted);
            return JSON.parse(json);
        },

        // ─── Base64 helpers ───
        _uint8ToBase64(u8) {
            let binary = '';
            for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
            return btoa(binary);
        },

        _base64ToUint8(b64) {
            const binary = atob(b64);
            const u8 = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
            return u8;
        }
    };

})();
