document.addEventListener('DOMContentLoaded', function () {
    const statusContent = {
        stage: document.getElementById('stage'),
        active: document.getElementById('active'),
        logined: document.getElementById('logined'),
        restarting_soon: document.getElementById('restarting_soon'),
        heapUsed: document.getElementById('heapUsed'),
    };
    const screenshotImg = document.getElementById('screenshot');
    const loadingOverlay = document.getElementById('loading-overlay');
    const terminalContainer = document.getElementById('terminal');

    const API_BASE_URL = `http://${window.location.hostname}:3562`;

    // --- Status Fetcher ---
    async function fetchStatus() {
        try {
            const response = await fetch(`${API_BASE_URL}/status`);
            if (!response.ok) throw new Error('Network response was not ok');
            const data = await response.json();

            for (const key in statusContent) {
                if (statusContent[key] && data[key] !== undefined) {
                    statusContent[key].textContent = data[key];
                    if (typeof data[key] === 'boolean') {
                        statusContent[key].className = data[key].toString();
                    }
                }
            }
        } catch (error) {
            console.error('Failed to fetch status:', error);
            for (const key in statusContent) {
                if (statusContent[key]) statusContent[key].textContent = 'ошибка';
            }
        }
    }

    // --- Screenshot Updater ---
    function updateScreenshot() {
        loadingOverlay.classList.add('visible');
        const newSrc = `/screenshot.png?t=${Date.now()}`;
        const tempImg = new Image();
        tempImg.onload = () => {
            screenshotImg.src = newSrc;
            screenshotImg.style.opacity = '1';
            loadingOverlay.classList.remove('visible');
        };
        tempImg.onerror = () => {
            console.error('Failed to load screenshot.');
            loadingOverlay.textContent = 'Ошибка загрузки';
        };
        screenshotImg.style.opacity = '0.5';
        tempImg.src = newSrc;
    }

    // --- Terminal ---
    const term = new Terminal({
        cursorBlink: true,
        fontFamily: "'Roboto Mono', monospace",
        fontSize: 14,
        theme: {
            background: '#24283b',
            foreground: '#c0caf5',
        }
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainer);
    fitAddon.fit();

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.hostname}:6080/terminal`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('Terminal WebSocket connected');
        term.write('Соединение с терминалом установлено...\\r\\n');
    };

    ws.onmessage = (event) => {
        term.write(event.data);
    };

    ws.onerror = (error) => {
        console.error('WebSocket Error:', error);
        term.write('\\r\\n\\x1b[31mОшибка соединения с WebSocket.\\x1b[0m');
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected');
        term.write('\\r\\n\\x1b[31mСоединение с терминалом закрыто.\\x1b[0m');
    };


    term.onData(data => {
        ws.send(data);
    });

    window.addEventListener('resize', () => fitAddon.fit());

    // --- Init ---
    fetchStatus();
    updateScreenshot();
    setInterval(fetchStatus, 2000);
    setInterval(updateScreenshot, 10000);
}); 