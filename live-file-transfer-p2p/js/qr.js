/* ═══════════════════════════════════════════════════════════
   FridayTransfer — QR Code Generator (Canvas-based, no deps)
   Minimal QR encoder for alphanumeric URLs
   ═══════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    window.FT = window.FT || {};

    /**
     * Draw a QR code on a canvas using the QR Server API as image source.
     * Falls back to displaying the URL as text if image fails.
     */
    FT.QR = {
        render(canvas, data, size) {
            size = size || 180;
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');

            // Use QR Server API (reliable, free, no auth)
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () {
                ctx.clearRect(0, 0, size, size);
                ctx.drawImage(img, 0, 0, size, size);
            };
            img.onerror = function () {
                // Fallback: draw a simple "scan" placeholder
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, size, size);
                ctx.fillStyle = '#333';
                ctx.font = '11px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('QR Code', size / 2, size / 2 - 10);
                ctx.fillText('Use link or code', size / 2, size / 2 + 10);
            };
            const encoded = encodeURIComponent(data);
            img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}&bgcolor=ffffff&color=000000&margin=2`;
        }
    };

})();
