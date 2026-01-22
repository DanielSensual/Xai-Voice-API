// Grok Voice Agent WebSocket Client
const WEBSOCKET_URL = 'wss://api.x.ai/v1/realtime';
const SAMPLE_RATE = 24000;

// State
let ws = null;
let audioContext = null;
let mediaStream = null;
let workletNode = null;
let isRecording = false;
let audioQueue = [];
let isPlaying = false;

// DOM Elements
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const micButton = document.getElementById('micButton');
const micLabel = micButton.querySelector('.mic-label');
const connectBtn = document.getElementById('connectBtn');
const voiceSelect = document.getElementById('voiceSelect');
const instructionsInput = document.getElementById('instructions');
const transcript = document.getElementById('transcript');
const debugLog = document.getElementById('debugLog');

// Utility Functions
function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.textContent = `[${time}] ${message}`;
    div.style.color = type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : '#a0a0b0';
    debugLog.appendChild(div);
    debugLog.scrollTop = debugLog.scrollHeight;
    console.log(`[${type}]`, message);
}

function setStatus(status, text) {
    statusDot.className = 'status-dot ' + status;
    statusText.textContent = text;
}

function addTranscript(role, text) {
    const item = document.createElement('div');
    item.className = `transcript-item ${role}`;
    item.innerHTML = `
    <div class="transcript-role">${role}</div>
    <div class="transcript-text">${text}</div>
  `;
    transcript.appendChild(item);
    transcript.scrollTop = transcript.scrollHeight;
}

// Audio Processing
function float32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
}

function int16ToFloat32(int16Array) {
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
    }
    return float32Array;
}

function base64ToInt16(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
}

function int16ToBase64(int16Array) {
    const bytes = new Uint8Array(int16Array.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// Audio Playback Queue
async function playAudioChunk(base64Audio) {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    }

    const int16Data = base64ToInt16(base64Audio);
    const float32Data = int16ToFloat32(int16Data);

    const audioBuffer = audioContext.createBuffer(1, float32Data.length, SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(float32Data);

    audioQueue.push(audioBuffer);

    if (!isPlaying) {
        playNextInQueue();
    }
}

function playNextInQueue() {
    if (audioQueue.length === 0) {
        isPlaying = false;
        return;
    }

    isPlaying = true;
    const buffer = audioQueue.shift();
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = playNextInQueue;
    source.start();
}

// WebSocket Connection
async function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
        return;
    }

    setStatus('connecting', 'Connecting...');
    log('Fetching ephemeral token...');

    try {
        // Get ephemeral token from our server
        const tokenResponse = await fetch('/session', { method: 'POST' });
        if (!tokenResponse.ok) {
            throw new Error('Failed to get session token');
        }
        const tokenData = await tokenResponse.json();

        if (!tokenData.client_secret?.value) {
            throw new Error('Invalid token response');
        }

        const token = tokenData.client_secret.value;
        log('Got ephemeral token', 'success');

        // Connect to xAI WebSocket
        ws = new WebSocket(WEBSOCKET_URL);

        ws.onopen = () => {
            log('WebSocket connected', 'success');
            setStatus('connected', 'Connected');
            connectBtn.textContent = 'Disconnect';
            connectBtn.classList.add('connected');
            micButton.disabled = false;

            // Authenticate and configure session
            const authMessage = {
                type: 'session.update',
                session: {
                    voice: voiceSelect.value,
                    instructions: instructionsInput.value,
                    turn_detection: { type: 'server_vad' },
                    audio: {
                        input: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
                        output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } }
                    }
                }
            };

            // Send auth header via first message (token-based auth)
            ws.send(JSON.stringify({
                type: 'session.update',
                session: {
                    ...authMessage.session
                }
            }));

            // Actually authenticate with the token
            // Note: For browser WebSocket, we need to use a query param or handle via proxy
            // Since browser doesn't support custom headers on WebSocket, we'll close and reconnect via server proxy
            // For now, let's try direct connection approach
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            log(`Received: ${data.type}`);

            switch (data.type) {
                case 'session.created':
                case 'session.updated':
                    log('Session configured', 'success');
                    break;

                case 'conversation.created':
                    log('Conversation started', 'success');
                    break;

                case 'input_audio_buffer.speech_started':
                    log('Speech detected');
                    setStatus('recording', 'Listening...');
                    break;

                case 'input_audio_buffer.speech_stopped':
                    log('Speech ended');
                    setStatus('connected', 'Processing...');
                    break;

                case 'conversation.item.input_audio_transcription.completed':
                    addTranscript('user', data.transcript);
                    break;

                case 'response.output_audio_transcript.delta':
                    // Accumulate transcript (handled in done event)
                    break;

                case 'response.output_audio_transcript.done':
                    if (data.transcript) {
                        addTranscript('assistant', data.transcript);
                    }
                    break;

                case 'response.output_audio.delta':
                    if (data.delta) {
                        playAudioChunk(data.delta);
                    }
                    break;

                case 'response.done':
                    log('Response complete', 'success');
                    setStatus('connected', 'Connected');
                    break;

                case 'error':
                    log(`Error: ${data.error?.message || 'Unknown error'}`, 'error');
                    break;
            }
        };

        ws.onerror = (error) => {
            log('WebSocket error', 'error');
            setStatus('error', 'Error');
        };

        ws.onclose = () => {
            log('WebSocket closed');
            setStatus('', 'Disconnected');
            connectBtn.textContent = 'Connect';
            connectBtn.classList.remove('connected');
            micButton.disabled = true;
            stopRecording();
        };

    } catch (error) {
        log(`Connection error: ${error.message}`, 'error');
        setStatus('error', 'Connection Failed');
    }
}

// Connect via server-side WebSocket proxy (handles authentication)
async function connectWithToken() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
        return;
    }

    setStatus('connecting', 'Connecting...');
    log('Connecting via WebSocket proxy...');

    try {
        // Connect to our local WebSocket proxy (which handles xAI auth)
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            log('Connected to proxy, waiting for xAI...', 'success');
        };

        setupWebSocketHandlers();

    } catch (error) {
        log(`Connection error: ${error.message}`, 'error');
        setStatus('error', 'Connection Failed');
    }
}

function setupWebSocketHandlers() {
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        log(`← ${data.type}`);

        switch (data.type) {
            case 'proxy.connected':
                // Proxy connected to xAI, now configure session
                log('xAI connected, configuring session...', 'success');
                ws.send(JSON.stringify({
                    type: 'session.update',
                    session: {
                        voice: voiceSelect.value,
                        instructions: instructionsInput.value,
                        turn_detection: { type: 'server_vad' },
                        audio: {
                            input: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
                            output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } }
                        }
                    }
                }));
                setStatus('connected', 'Connected');
                connectBtn.textContent = 'Disconnect';
                connectBtn.classList.add('connected');
                micButton.disabled = false;
                break;

            case 'session.created':
            case 'session.updated':
                log('Session ready', 'success');
                break;

            case 'conversation.created':
                log('Conversation started', 'success');
                break;

            case 'input_audio_buffer.speech_started':
                setStatus('recording', 'Listening...');
                break;

            case 'input_audio_buffer.speech_stopped':
                setStatus('connected', 'Processing...');
                break;

            case 'conversation.item.input_audio_transcription.completed':
                addTranscript('user', data.transcript);
                break;

            case 'response.output_audio_transcript.done':
                if (data.transcript) {
                    addTranscript('assistant', data.transcript);
                }
                break;

            case 'response.output_audio.delta':
                if (data.delta) {
                    playAudioChunk(data.delta);
                }
                break;

            case 'response.done':
                setStatus('connected', 'Connected');
                break;

            case 'error':
                log(`Error: ${JSON.stringify(data.error || data)}`, 'error');
                break;
        }
    };

    ws.onerror = (error) => {
        log('WebSocket error', 'error');
        setStatus('error', 'Error');
    };

    ws.onclose = (event) => {
        log(`WebSocket closed: ${event.code} ${event.reason}`);
        setStatus('', 'Disconnected');
        connectBtn.textContent = 'Connect';
        connectBtn.classList.remove('connected');
        micButton.disabled = true;
        stopRecording();
    };
}

// Microphone Recording
async function startRecording() {
    if (isRecording) return;

    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
        }

        // Resume audio context if suspended
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: SAMPLE_RATE,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        const source = audioContext.createMediaStreamSource(mediaStream);

        // Create a ScriptProcessor (deprecated but widely supported)
        // For production, use AudioWorklet
        const bufferSize = 4096;
        const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

        processor.onaudioprocess = (e) => {
            if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;

            const inputData = e.inputBuffer.getChannelData(0);
            const int16Data = float32ToInt16(inputData);
            const base64Audio = int16ToBase64(int16Data);

            ws.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: base64Audio
            }));
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        isRecording = true;
        micButton.classList.add('recording');
        micLabel.textContent = 'Stop';
        setStatus('recording', 'Recording...');
        log('Recording started', 'success');

    } catch (error) {
        log(`Microphone error: ${error.message}`, 'error');
    }
}

function stopRecording() {
    if (!isRecording) return;

    isRecording = false;
    micButton.classList.remove('recording');
    micLabel.textContent = 'Start';

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    log('Recording stopped');

    if (ws && ws.readyState === WebSocket.OPEN) {
        setStatus('connected', 'Connected');
    }
}

function toggleRecording() {
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
}

// Event Listeners
connectBtn.addEventListener('click', connectWithToken);
micButton.addEventListener('click', toggleRecording);

// Voice change while connected
voiceSelect.addEventListener('change', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'session.update',
            session: {
                voice: voiceSelect.value
            }
        }));
        log(`Voice changed to ${voiceSelect.value}`);
    }
});

// Initialize
log('Grok Voice Agent Test App initialized');
log('Click "Connect" to start');
