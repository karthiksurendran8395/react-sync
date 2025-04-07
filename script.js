// --- Global Variables & DOM References ---
const statusElement = document.getElementById('status');
const loadBtn = document.getElementById('loadVideosBtn');
const videoId1Input = document.getElementById('videoId1');
const videoId2Input = document.getElementById('videoId2');
const toggleViewBtn = document.getElementById('toggleViewBtn');
const mainContainer = document.querySelector('.main-container');
const syncToggleCheckbox = document.getElementById('syncToggleCheckbox');

// Central Controls References
const centralControlsContainer = document.getElementById('centralControls');
const centralPlayPauseBtn = document.getElementById('centralPlayPauseBtn');
const centralSeekBar = document.getElementById('centralSeekBar');
const centralCurrentTime = document.getElementById('centralCurrentTime');
const centralDuration = document.getElementById('centralDuration');
const centralSkipBackwardBtn = document.getElementById('centralSkipBackwardBtn');
const centralSkipForwardBtn = document.getElementById('centralSkipForwardBtn');


// Player instances
let player1 = null;
let player2 = null;
let playersReady = 0;

// --- Sync State Variables ---
let isSyncGloballyEnabled = true;
let syncOffsetSeconds = 0;

// --- Overlap Calculation State ---
let overlapStartP1 = 0; // The time on Player 1 where the overlap begins
let overlapEndP1 = Infinity; // The time on Player 1 where the overlap ends
let overlapDuration = 0; // The calculated duration of the overlap

// --- State Preservation During Recreate ---
let storedVideoId1 = '';
let storedVideoId2 = '';
let tempStartTimeP1 = 0; // Time to seek P1 to after recreation
let tempSyncOffset = 0;  // Offset to use when calculating P2 seek time after recreation
let isRecreating = false; // Flag to indicate recreation is in progress

// --- Drift Monitoring Variables ---
let driftLogInterval = null; // Timer for *logging* drift
const DRIFT_LOG_INTERVAL_MS = 2000; // Log every 2 seconds

// --- Central Controller UI Update Timer ---
let uiUpdateInterval = null;
const UI_UPDATE_INTERVAL_MS = 250; // Update UI 4 times per second

// --- Helper Functions ---
function extractVideoId(input) {
    if (!input) return null; input = input.trim();
    const urlRegex = /(?:watch\?v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/; const match = input.match(urlRegex);
    if (match && match[1]) { return match[1]; } const plainIdRegex = /^[a-zA-Z0-9_-]{11}$/;
    if (plainIdRegex.test(input)) { return input; } console.warn(`Could not extract valid video ID from input: "${input}"`); return null;
}
function formatTime(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) { return "0:00"; } const minutes = Math.floor(totalSeconds / 60); const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
function getPlayerStateName(stateCode) { for (const state in YT.PlayerState) { if (YT.PlayerState[state] === stateCode) { return state; } } return `UNKNOWN (${stateCode})`; }


// --- YouTube IFrame API Setup ---
window.onYouTubeIframeAPIReady = function() {
    console.log("YouTube IFrame API Ready"); if (statusElement) statusElement.textContent = 'API Loaded. Enter Video URLs/IDs and click "Load Videos".';
    if (loadBtn) { loadBtn.disabled = false; console.log("Load Videos button enabled."); } else { console.error("Load button not found when API ready!"); }
};


// --- Core Player Logic ---
function loadVideos() {
    console.log("loadVideos function called."); if (!videoId1Input || !videoId2Input || !statusElement || !loadBtn || !syncToggleCheckbox) { console.error("Required elements missing for loadVideos."); if (statusElement) statusElement.textContent = "Error: UI elements missing."; return; }
    const videoId1 = extractVideoId(videoId1Input.value); const videoId2 = extractVideoId(videoId2Input.value); let errorMessages = []; if (!videoId1) errorMessages.push('Invalid URL or ID for Left Video.'); if (!videoId2) errorMessages.push('Invalid URL or ID for Right Video.');
    if (errorMessages.length > 0) { statusElement.textContent = errorMessages.join(' '); if (!videoId1) videoId1Input.focus(); else videoId2Input.focus(); return; } console.log("Loading videos with IDs:", videoId1, videoId2); statusElement.textContent = 'Loading videos...'; loadBtn.disabled = true;
    playersReady = 0; isRecreating = false; stopDriftLogTimer(); stopUiUpdateTimer(); destroyPlayers(); isSyncGloballyEnabled = true; syncOffsetSeconds = 0; overlapStartP1 = 0; overlapEndP1 = Infinity; overlapDuration = 0;
    if (syncToggleCheckbox) syncToggleCheckbox.checked = true; setCentralControlsEnabled(false);
    storedVideoId1 = videoId1; storedVideoId2 = videoId2; const initialControls = syncToggleCheckbox.checked ? 0 : 1; console.log(`Initial load: Sync enabled = ${syncToggleCheckbox.checked}, Native controls = ${initialControls}`);
    createPlayer('player1', videoId1, initialControls); createPlayer('player2', videoId2, initialControls);
}
function createPlayer(elementId, videoId, controlsValue) {
     console.log(`Creating player ${elementId} with Video ID ${videoId} and controls=${controlsValue}`); try { const playerVarOptions = { 'playsinline': 1, 'enablejsapi': 1, 'controls': controlsValue, };
         if (elementId === 'player1') { player1 = new YT.Player(elementId, { height: '360', width: '640', videoId: videoId, playerVars: playerVarOptions, events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange } }); }
         else { player2 = new YT.Player(elementId, { height: '360', width: '640', videoId: videoId, playerVars: playerVarOptions, events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange } }); }
     } catch (error) { console.error(`Error creating player ${elementId}:`, error); if (statusElement) statusElement.textContent = "Error loading players. Check console."; }
}
function destroyPlayers() {
    console.log("Destroying existing players..."); stopDriftLogTimer(); stopUiUpdateTimer(); isRecreating = false;
    if (player1 && typeof player1.destroy === 'function') { try { player1.destroy(); console.log("Player 1 destroyed."); } catch (e) { console.warn("Error destroying player1:", e)} player1 = null; }
    if (player2 && typeof player2.destroy === 'function') { try { player2.destroy(); console.log("Player 2 destroyed."); } catch (e) { console.warn("Error destroying player2:", e)} player2 = null; }
    const p1Element = document.getElementById('player1'); if (p1Element) p1Element.innerHTML = ''; const p2Element = document.getElementById('player2'); if (p2Element) p2Element.innerHTML = '';
}

// --- onPlayerReady (Handles Initial Load and Post-Recreation) ---
function onPlayerReady(event) {
    playersReady++;
    const playerName = event.target === player1 ? "Player 1 (Left)" : "Player 2 (Right)";
    console.log(`${playerName} is Ready. Total ready: ${playersReady}`);

    if (playersReady === 2) {
        console.log("Both players ready.");
        if (loadBtn) loadBtn.disabled = false;

        if (isRecreating) {
            // --- Post-Recreation Logic ---
            console.log(`Recreation complete. Restoring state: P1 time=${tempStartTimeP1.toFixed(2)}, Captured Offset=${tempSyncOffset.toFixed(2)}`);
            syncOffsetSeconds = tempSyncOffset; calculateOverlap();
            const targetP1 = Math.max(overlapStartP1, Math.min(tempStartTimeP1, overlapEndP1));
            const targetP2 = targetP1 + syncOffsetSeconds;
            console.log(`Seeking post-recreate: P1 to ${targetP1.toFixed(2)}, P2 to ${targetP2.toFixed(2)} (Overlap: ${overlapStartP1.toFixed(2)}-${overlapEndP1.toFixed(2)})`);
            try {
                player1.seekTo(targetP1, true); player2.seekTo(Math.max(0, targetP2), true);
                setTimeout(() => { // Pause after seek
                    if (player1 && player2) {
                        player1.pauseVideo(); player2.pauseVideo(); console.log("Players paused after recreation seek.");
                        isSyncGloballyEnabled = syncToggleCheckbox.checked;
                        if (isSyncGloballyEnabled && overlapDuration > 0) {
                            setCentralControlsEnabled(true); updateCentralControllerUI(player1, YT.PlayerState.PAUSED); console.log("Central controls enabled post-recreation.");
                        } else {
                            setCentralControlsEnabled(false); console.log(overlapDuration <= 0 ? "No overlap, keeping central controls disabled." : "Native controls enabled post-recreation.");
                        }
                        updateSyncStatusMessage(); startDriftLogTimer();
                    } else { console.warn("Players became invalid during post-recreation pause timeout."); }
                    isRecreating = false; tempStartTimeP1 = 0; tempSyncOffset = 0; statusElement.textContent = "Players Ready.";
                }, 200);
            } catch (e) { console.error("Error seeking/pausing players after recreation:", e); isRecreating = false; setCentralControlsEnabled(false); updateSyncStatusMessage(); startDriftLogTimer(); statusElement.textContent = "Error restoring state."; }
        } else {
            // --- Initial Load Logic ---
            console.log("Initial load complete."); isSyncGloballyEnabled = syncToggleCheckbox.checked;
            if (isSyncGloballyEnabled) {
                 try {
                     const time1 = player1.getCurrentTime(); const time2 = player2.getCurrentTime(); syncOffsetSeconds = time2 - time1; console.log(`Initial Offset (P2 - P1): ${syncOffsetSeconds.toFixed(2)}s`); calculateOverlap();
                     player1.pauseVideo(); player2.pauseVideo(); const targetP1 = Math.max(0, overlapStartP1); const targetP2Time = targetP1 + syncOffsetSeconds; player1.seekTo(targetP1, true); player2.seekTo(Math.max(0, targetP2Time), true); console.log(`Initial seek: P1 to ${targetP1.toFixed(2)}, P2 to ${targetP2Time.toFixed(2)}`);
                     if (overlapDuration > 0) {
                         setCentralControlsEnabled(true); setTimeout(() => updateCentralControllerUI(player1, YT.PlayerState.PAUSED), 100);
                     } else { setCentralControlsEnabled(false); }
                 } catch(e) { console.error("Error during initial sync setup:", e); setCentralControlsEnabled(false); }
            } else { setCentralControlsEnabled(false); try { player1.pauseVideo(); player2.pauseVideo(); } catch(e){} }
            updateSyncStatusMessage(); startDriftLogTimer(); statusElement.textContent = "Players Ready.";
        }
    } else if (playersReady < 2) { if (!isRecreating) { statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`; } }
}

// --- Calculate Overlap ---
function calculateOverlap() {
    overlapStartP1 = 0; overlapEndP1 = Infinity; overlapDuration = 0;
    if (playersReady < 2 || !player1 || !player2 || typeof player1.getDuration !== 'function' || typeof player2.getDuration !== 'function') { console.log("Cannot calculate overlap: Players not ready or lack methods."); return; }
    try {
        const duration1 = player1.getDuration(); const duration2 = player2.getDuration(); if (duration1 <= 0 || duration2 <= 0) { console.log("Cannot calculate overlap: Durations invalid (<= 0)."); return; }
        overlapStartP1 = Math.max(0, -syncOffsetSeconds); const endP1_limit1 = duration1; const endP1_limit2 = duration2 - syncOffsetSeconds; overlapEndP1 = Math.min(endP1_limit1, endP1_limit2); overlapDuration = Math.max(0, overlapEndP1 - overlapStartP1);
        console.log(`Overlap Calculated: P1 Duration=${duration1.toFixed(2)}, P2 Duration=${duration2.toFixed(2)}, Offset=${syncOffsetSeconds.toFixed(2)}`); console.log(`  -> Overlap in P1 Time: [${overlapStartP1.toFixed(2)}, ${overlapEndP1.toFixed(2)}] (Duration: ${overlapDuration.toFixed(2)}s)`);
        if (overlapDuration <= 0) { console.warn("No overlap detected between videos with current offset."); }
    } catch (e) { console.error("Error calculating overlap:", e); overlapStartP1 = 0; overlapEndP1 = Infinity; overlapDuration = 0; }
}


// --- onPlayerStateChange ---
function onPlayerStateChange(event) {
    if (isRecreating) { console.log("State change ignored during player recreation."); return; } if (playersReady < 2) return;
    const changedPlayer = event.target; const newState = event.data;
    if (isSyncGloballyEnabled && changedPlayer === player1) { console.log(`P1 State Changed (Sync ON): ${getPlayerStateName(newState)} -> Updating Central UI`); updateCentralControllerUI(player1, newState); }
    else if (!isSyncGloballyEnabled) { try { const sourceTime = changedPlayer.getCurrentTime(); console.log(`State Change (Sync OFF) by ${changedPlayer === player1 ? 'P1':'P2'}: ${getPlayerStateName(newState)} @ ${sourceTime.toFixed(2)}s`); } catch(e) { /* ignore */ } }
    else if (isSyncGloballyEnabled && changedPlayer === player2) { console.log(`P2 State Changed (Sync ON, Ignored for UI): ${getPlayerStateName(newState)}`); }
}


// --- Central Controls Logic ---
function setCentralControlsEnabled(enabled) {
    if (!centralControlsContainer) return; if (enabled) { centralControlsContainer.classList.remove('controls-disabled'); if (centralPlayPauseBtn) centralPlayPauseBtn.disabled = false; if (centralSeekBar) centralSeekBar.disabled = false; if (centralSkipBackwardBtn) centralSkipBackwardBtn.disabled = false; if (centralSkipForwardBtn) centralSkipForwardBtn.disabled = false; console.log("Central controls ENABLED."); }
    else { centralControlsContainer.classList.add('controls-disabled'); if (centralPlayPauseBtn) centralPlayPauseBtn.disabled = true; if (centralSeekBar) centralSeekBar.disabled = true; if (centralSkipBackwardBtn) centralSkipBackwardBtn.disabled = true; if (centralSkipForwardBtn) centralSkipForwardBtn.disabled = true; stopUiUpdateTimer(); console.log("Central controls DISABLED."); if(centralPlayPauseBtn) centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>'; if(centralSeekBar) { centralSeekBar.value = 0; centralSeekBar.max = 100; } if(centralCurrentTime) centralCurrentTime.textContent = "0:00"; if(centralDuration) centralDuration.textContent = "0:00"; }
}
function updateCentralControllerUI(player, state) {
    if (!player || typeof player.getDuration !== 'function' || typeof player.getCurrentTime !== 'function' || !centralControlsContainer) return; if (!isSyncGloballyEnabled || centralControlsContainer.classList.contains('controls-disabled')) return;
    if (overlapDuration <= 0 || overlapEndP1 === Infinity) { calculateOverlap(); if (overlapDuration <= 0) { console.log("Update UI skipped: No valid overlap duration calculated yet."); setCentralControlsEnabled(false); return; } }
    try {
        const currentTimeP1 = player.getCurrentTime(); const currentState = state !== undefined ? state : player.getPlayerState(); const clampedCurrentTimeP1 = Math.max(overlapStartP1, Math.min(currentTimeP1, overlapEndP1)); const currentOverlapTime = clampedCurrentTimeP1 - overlapStartP1;
        if (centralSeekBar) { if (overlapDuration > 0 && Math.abs(centralSeekBar.max - overlapDuration) > 0.1) { centralSeekBar.max = overlapDuration; } if (!centralSeekBar.matches(':active')) { centralSeekBar.value = Math.max(0, Math.min(currentOverlapTime, overlapDuration)); } }
        if (centralCurrentTime) centralCurrentTime.textContent = formatTime(currentOverlapTime); if (centralDuration) centralDuration.textContent = formatTime(overlapDuration);
        if (centralPlayPauseBtn) { if (currentState === YT.PlayerState.PLAYING) { centralPlayPauseBtn.innerHTML = '<i class="fas fa-pause"></i>'; centralPlayPauseBtn.title = "Pause"; startUiUpdateTimer(); } else { centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>'; centralPlayPauseBtn.title = "Play"; stopUiUpdateTimer(); if ((currentState === YT.PlayerState.PAUSED || currentState === YT.PlayerState.ENDED) && centralSeekBar && !centralSeekBar.matches(':active')) { centralSeekBar.value = Math.max(0, Math.min(currentOverlapTime, overlapDuration)); } } }
    } catch (e) { console.warn("Error updating central controller UI:", e); stopUiUpdateTimer(); }
}
function startUiUpdateTimer() { if (uiUpdateInterval) return; stopUiUpdateTimer(); console.log("Starting UI update timer."); uiUpdateInterval = setInterval(() => { if (player1 && isSyncGloballyEnabled && !centralControlsContainer.classList.contains('controls-disabled') && typeof player1.getCurrentTime === 'function') { updateCentralControllerUI(player1); } else { stopUiUpdateTimer(); } }, UI_UPDATE_INTERVAL_MS); }
function stopUiUpdateTimer() { if (uiUpdateInterval) { console.log("Stopping UI update timer."); clearInterval(uiUpdateInterval); uiUpdateInterval = null; } }


// --- Event Listeners Setup ---
function setupButtonListeners() {
    // Load Videos
    if (loadBtn) { loadBtn.onclick = loadVideos; console.log("Load Videos listener attached."); }
    else { console.error("Load Videos button not found!"); }

    // Toggle View / Cinema Mode
    if (toggleViewBtn && mainContainer) {
        toggleViewBtn.onclick = () => {
            mainContainer.classList.toggle('controls-hidden'); // This class now means "Cinema Mode Active"
            document.body.classList.toggle('fullscreen-active'); // Used for body background/padding
            const isCinemaMode = mainContainer.classList.contains('controls-hidden');

            // --- UPDATED TEXT/TITLE ---
            if (isCinemaMode) {
                toggleViewBtn.innerHTML = '<i class="fas fa-compress"></i> Exit Cinema Mode'; // Icon for exiting
                toggleViewBtn.title = "Exit Cinema Mode";
                toggleViewBtn.setAttribute('aria-pressed', 'true');
                 console.log("Cinema Mode Entered.");
            } else {
                toggleViewBtn.innerHTML = '<i class="fas fa-expand"></i> Cinema Mode'; // Icon for entering
                toggleViewBtn.title = "Enter Cinema Mode";
                toggleViewBtn.setAttribute('aria-pressed', 'false');
                console.log("Cinema Mode Exited.");
            }
            window.dispatchEvent(new Event('resize')); // Helps redraw players, especially on exit
        };
        console.log("Toggle view (Cinema Mode) listener attached.");
    } else { console.warn("Toggle view button or main container not found."); }

    // Sync Toggle
    if (syncToggleCheckbox) { syncToggleCheckbox.onchange = handleSyncToggleChange; console.log("Sync toggle listener attached."); }
    else { console.warn("Sync toggle checkbox not found."); }

    // --- Central Controller Listeners ---
    if (centralPlayPauseBtn) {
        centralPlayPauseBtn.onclick = () => {
            if (!player1 || !player2 || !isSyncGloballyEnabled) return;
            try {
                const state = player1.getPlayerState();
                if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) { console.log("Central Control: Pausing both players."); player1.pauseVideo(); player2.pauseVideo(); }
                else { console.log("Central Control: Playing both players."); player1.playVideo(); player2.playVideo(); }
            } catch (e) { console.error("Error handling central play/pause:", e); }
        }; console.log("Central play/pause listener attached.");
    } else { console.warn("Central play/pause button not found."); }

    if (centralSeekBar) {
        centralSeekBar.addEventListener('input', () => {
             if (!player1 || !isSyncGloballyEnabled || overlapDuration <= 0) return; const seekOverlapTime = parseFloat(centralSeekBar.value); if (centralCurrentTime) { centralCurrentTime.textContent = formatTime(seekOverlapTime); }
        });
        centralSeekBar.addEventListener('change', () => {
            if (!player1 || !player2 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
            try {
                const seekOverlapTime = parseFloat(centralSeekBar.value); const seekTimeP1 = seekOverlapTime + overlapStartP1; const clampedSeekTimeP1 = Math.max(overlapStartP1, Math.min(seekTimeP1, overlapEndP1)); const seekTimeP2 = clampedSeekTimeP1 + syncOffsetSeconds;
                console.log(`Central Control Seek: OverlapValue=${seekOverlapTime.toFixed(2)} -> Seeking P1 to ${clampedSeekTimeP1.toFixed(2)}s, P2 to ${seekTimeP2.toFixed(2)}s`);
                const wasPlaying = player1.getPlayerState() === YT.PlayerState.PLAYING; if (wasPlaying) { player1.pauseVideo(); player2.pauseVideo(); }
                player1.seekTo(clampedSeekTimeP1, true); player2.seekTo(Math.max(0, seekTimeP2), true);
                if (wasPlaying) { setTimeout(() => { if (player1 && player2 && isSyncGloballyEnabled) { player1.playVideo(); player2.playVideo(); } }, 150); }
                else { const finalOverlapTime = clampedSeekTimeP1 - overlapStartP1; if (centralCurrentTime) centralCurrentTime.textContent = formatTime(finalOverlapTime); if (centralSeekBar) centralSeekBar.value = finalOverlapTime; }
            } catch (e) { console.error("Error handling central seek:", e); if (player1 && player1.getPlayerState() === YT.PlayerState.PLAYING) { startUiUpdateTimer(); } }
        }); console.log("Central seek bar listeners attached.");
    } else { console.warn("Central seek bar not found."); }

    if (centralSkipForwardBtn) { centralSkipForwardBtn.onclick = () => handleSkip(5); console.log("Central skip forward listener attached."); }
    else { console.warn("Central skip forward button not found."); }
    if (centralSkipBackwardBtn) { centralSkipBackwardBtn.onclick = () => handleSkip(-5); console.log("Central skip backward listener attached."); }
    else { console.warn("Central skip backward button not found."); }
}


// --- Handler for Sync Toggle Change (Handles Player Recreation & Offset) ---
function handleSyncToggleChange() {
    if (!syncToggleCheckbox || isRecreating) return; // Prevent action if already recreating

    const targetSyncStateEnabled = syncToggleCheckbox.checked;
    console.log("Sync toggle changed. Target state:", targetSyncStateEnabled ? "ENABLED" : "DISABLED");

    isSyncGloballyEnabled = targetSyncStateEnabled; // Update global var for status message logic NOW
    updateSyncStatusMessage();

    if (!player1 || !player2 || playersReady < 2) { console.log("Sync toggle changed, but players not ready. Will apply state when ready."); setCentralControlsEnabled(false); return; }

    console.log("Initiating player recreation due to sync toggle change..."); isRecreating = true; statusElement.textContent = "Reconfiguring players..."; setCentralControlsEnabled(false); stopDriftLogTimer(); stopUiUpdateTimer();

    try { // Capture state
        tempStartTimeP1 = player1.getCurrentTime();
        if (targetSyncStateEnabled) { const currentTimeP2 = player2.getCurrentTime(); tempSyncOffset = currentTimeP2 - tempStartTimeP1; console.log(`Sync Enabling: Captured state & calculated NEW offset: P1 Time=${tempStartTimeP1.toFixed(2)}, Offset=${tempSyncOffset.toFixed(2)}`); }
        else { tempSyncOffset = 0; console.log(`Sync Disabling: Captured state: P1 Time=${tempStartTimeP1.toFixed(2)}`); }
        player1.pauseVideo(); player2.pauseVideo();
    } catch (e) { console.warn("Error capturing state before recreation:", e); tempStartTimeP1 = 0; tempSyncOffset = 0; }

    const newControlsValue = targetSyncStateEnabled ? 0 : 1; // 0=Hidden, 1=Shown
    console.log(`Target native controls value: ${newControlsValue}`);

    setTimeout(() => { // Destroy and recreate after pause registers
        destroyPlayers(); isRecreating = true; playersReady = 0; console.log("Recreating players now...");
        if (storedVideoId1 && storedVideoId2) { createPlayer('player1', storedVideoId1, newControlsValue); createPlayer('player2', storedVideoId2, newControlsValue); }
        else { console.error("Cannot recreate players: Stored video IDs are missing."); statusElement.textContent = "Error: Cannot reconfigure players."; isRecreating = false; if (loadBtn) loadBtn.disabled = false; }
     }, 150);
}


// --- Handler for Skip Buttons (Considers Overlap) ---
function handleSkip(secondsToSkip) {
     if (!player1 || !player2 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
     try {
         const currentTimeP1 = player1.getCurrentTime(); const targetTimeP1 = currentTimeP1 + secondsToSkip; const seekTimeP1 = Math.max(overlapStartP1, Math.min(targetTimeP1, overlapEndP1)); const seekTimeP2 = seekTimeP1 + syncOffsetSeconds;
         console.log(`Central Control Skip: ${secondsToSkip}s -> Clamped Seek P1 to ${seekTimeP1.toFixed(2)}s, P2 to ${seekTimeP2.toFixed(2)}s`);
         player1.seekTo(seekTimeP1, true); player2.seekTo(Math.max(0, seekTimeP2), true);
         const seekOverlapTime = seekTimeP1 - overlapStartP1; if(centralSeekBar) centralSeekBar.value = seekOverlapTime; if(centralCurrentTime) centralCurrentTime.textContent = formatTime(seekOverlapTime);
         if (player1.getPlayerState() !== YT.PlayerState.PLAYING) { setTimeout(() => updateCentralControllerUI(player1), 50); }
     } catch (e) { console.error(`Error handling skip (${secondsToSkip}s):`, e); }
}

// --- Drift Monitoring Logic ---
function logDrift() { if (isRecreating || playersReady < 2 || !player1 || !player2 || typeof player1.getCurrentTime !== 'function' || typeof player2.getCurrentTime !== 'function') { return; } try { const time1 = player1.getCurrentTime(); const time2 = player2.getCurrentTime(); const actualOffset = time2 - time1; const drift = actualOffset - syncOffsetSeconds; console.log( `Drift Monitor | P1: ${time1.toFixed(3)}s | P2: ${time2.toFixed(3)}s | Actual Offset: ${actualOffset.toFixed(3)}s | Expected Offset: ${syncOffsetSeconds.toFixed(3)}s | Drift: ${drift.toFixed(3)}s` ); } catch (e) { console.warn("Error during drift logging:", e); } }
function startDriftLogTimer() { if (driftLogInterval) return; stopDriftLogTimer(); console.log(`Starting drift monitor log timer (Interval: ${DRIFT_LOG_INTERVAL_MS}ms)`); driftLogInterval = setInterval(logDrift, DRIFT_LOG_INTERVAL_MS); }
function stopDriftLogTimer() { if (driftLogInterval) { console.log("Stopping drift monitor log timer."); clearInterval(driftLogInterval); driftLogInterval = null; } }


// --- UI Interaction Logic ---
function updateSyncStatusMessage() {
     if (!statusElement) return; if (isRecreating) { statusElement.textContent = "Reconfiguring players..."; return; } if (playersReady < 2 && (statusElement.textContent.includes("Loading") || statusElement.textContent.includes("Error"))) { return; }
     const currentSyncEnabledState = syncToggleCheckbox ? syncToggleCheckbox.checked : isSyncGloballyEnabled;
     if (currentSyncEnabledState) {
         let offsetMsg = ""; if (overlapDuration > 0 && Math.abs(syncOffsetSeconds) > 0.1) { const sign = syncOffsetSeconds > 0 ? "+" : ""; offsetMsg = ` (Offset: P2 ${sign}${syncOffsetSeconds.toFixed(2)}s)`; }
         const controlsActive = centralControlsContainer && !centralControlsContainer.classList.contains('controls-disabled');
         if (playersReady < 2) { statusElement.textContent = `Sync Enabled: Waiting for players...${offsetMsg}`; }
         else if (overlapDuration <= 0 && player1 && player2) { statusElement.textContent = `Sync Enabled: No overlapping playtime detected.${offsetMsg}`; } // Check players exist before saying no overlap
         else { statusElement.textContent = controlsActive ? `Sync Enabled: Central controls active.${offsetMsg}` : `Sync Enabled: Initializing...${offsetMsg}`; }
     } else {
         if (playersReady < 2) { statusElement.textContent = 'Sync Disabled: Waiting for players...'; }
         else { statusElement.textContent = 'Sync Disabled: Use individual player controls. Re-enable sync to use central controls and set offset.'; }
     }
}


// --- Initial Setup on DOM Load ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded. Setting up initial state and listeners.");
    if (loadBtn) { loadBtn.disabled = true; } if (mainContainer) mainContainer.classList.remove('controls-hidden'); document.body.classList.remove('fullscreen-active');
    if (toggleViewBtn) { // Set initial toggle button state for Cinema Mode
         toggleViewBtn.innerHTML = '<i class="fas fa-expand"></i> Cinema Mode';
         toggleViewBtn.title = "Enter Cinema Mode";
         toggleViewBtn.setAttribute('aria-pressed', 'false');
    }
    isSyncGloballyEnabled = syncToggleCheckbox ? syncToggleCheckbox.checked : true; syncOffsetSeconds = 0; overlapStartP1 = 0; overlapEndP1 = Infinity; overlapDuration = 0;
    setCentralControlsEnabled(false);
    setupButtonListeners(); updateSyncStatusMessage();
});
console.log("Initial script execution finished. Waiting for DOMContentLoaded and YouTube API Ready...");