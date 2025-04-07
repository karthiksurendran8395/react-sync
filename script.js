// --- Global Variables & DOM References ---
const statusElement = document.getElementById('status');
const loadBtn = document.getElementById('loadVideosBtn');
const videoId1Input = document.getElementById('videoId1');
const videoId2Input = document.getElementById('videoId2');
const toggleViewBtn = document.getElementById('toggleViewBtn');
const mainContainer = document.querySelector('.main-container');
const syncToggleCheckbox = document.getElementById('syncToggleCheckbox');

// NEW: Central Controls References
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
// REMOVED: isSyncing flag (less critical now, central commands are explicit)

// --- Sync State Variables ---
let isSyncGloballyEnabled = true; // Master switch for sync controls
let syncOffsetSeconds = 0; // Stores the time difference (P2 time - P1 time)
// REMOVED: SYNC_THRESHOLD_SEEK (less relevant for central control)
// REMOVED: syncTimeout (lock release mechanism no longer needed here)

// --- Drift Monitoring Variables (KEPT) ---
let driftLogInterval = null; // Timer for *logging* drift
const DRIFT_LOG_INTERVAL_MS = 2000; // Log every 2 seconds

// --- NEW: Central Controller UI Update Timer ---
let uiUpdateInterval = null;
const UI_UPDATE_INTERVAL_MS = 250; // Update UI 4 times per second

// --- Helper Functions ---
function extractVideoId(input) {
    if (!input) return null;
    input = input.trim();
    const urlRegex = /(?:watch\?v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/;
    const match = input.match(urlRegex);
    if (match && match[1]) { return match[1]; }
    const plainIdRegex = /^[a-zA-Z0-9_-]{11}$/;
    if (plainIdRegex.test(input)) { return input; }
    console.warn(`Could not extract valid video ID from input: "${input}"`);
    return null;
}

function formatTime(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) {
        return "0:00";
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function getPlayerStateName(stateCode) {
    for (const state in YT.PlayerState) {
        if (YT.PlayerState[state] === stateCode) { return state; }
    }
    return `UNKNOWN (${stateCode})`;
}


// --- YouTube IFrame API Setup ---
window.onYouTubeIframeAPIReady = function() {
    console.log("YouTube IFrame API Ready");
    if (statusElement) statusElement.textContent = 'API Loaded. Enter Video URLs/IDs and click "Load Videos".';
    if (loadBtn) {
        loadBtn.disabled = false;
        console.log("Load Videos button enabled.");
    } else {
        console.error("Load button not found when API ready!");
    }
};

// --- Core Player Logic ---
function loadVideos() {
    console.log("loadVideos function called.");
    if (!videoId1Input || !videoId2Input || !statusElement || !loadBtn || !syncToggleCheckbox) { /* ... */ return; }
    const videoId1 = extractVideoId(videoId1Input.value);
    const videoId2 = extractVideoId(videoId2Input.value);
    let errorMessages = [];
    if (!videoId1) errorMessages.push('Invalid URL or ID for Left Video.');
    if (!videoId2) errorMessages.push('Invalid URL or ID for Right Video.');
    if (errorMessages.length > 0) { /* ... */ return; }
    console.log("Loading videos with IDs:", videoId1, videoId2);
    statusElement.textContent = 'Loading videos...';
    loadBtn.disabled = true;

    // Reset State
    playersReady = 0;
    stopDriftLogTimer();
    stopUiUpdateTimer(); // Stop UI timer if running
    destroyPlayers();
    isSyncGloballyEnabled = true; // Reset sync state
    syncOffsetSeconds = 0;
    syncToggleCheckbox.checked = true; // Reset checkbox
    setCentralControlsEnabled(false); // Disable central controls initially
    console.log("State reset for load: Global Sync ON, Offset 0s, Central controls disabled.");

    try {
        // NOTE: We are NOT setting 'controls': 0. We rely on central controls when sync is ON.
        player1 = new YT.Player('player1', {
            height: '360', width: '640', videoId: videoId1,
            playerVars: { 'playsinline': 1, 'enablejsapi': 1 }, // Ensure JS API is enabled
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });
        player2 = new YT.Player('player2', {
            height: '360', width: '640', videoId: videoId2,
            playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });
    } catch (error) {
        console.error("Error creating YouTube players:", error);
        if (statusElement) statusElement.textContent = "Error loading players. Check console.";
        if(loadBtn) loadBtn.disabled = false;
    }
}

function destroyPlayers() {
    console.log("Destroying existing players...");
    stopDriftLogTimer();
    stopUiUpdateTimer();
    if (player1 && typeof player1.destroy === 'function') { try { player1.destroy(); } catch (e) { console.warn("Error destroying player1:", e)} player1 = null; }
    if (player2 && typeof player2.destroy === 'function') { try { player2.destroy(); } catch (e) { console.warn("Error destroying player2:", e)} player2 = null; }
    const p1Element = document.getElementById('player1'); if (p1Element) p1Element.innerHTML = '';
    const p2Element = document.getElementById('player2'); if (p2Element) p2Element.innerHTML = '';
}

function onPlayerReady(event) {
    playersReady++;
    const playerName = event.target === player1 ? "Player 1 (Left)" : "Player 2 (Right)";
    console.log(`${playerName} is Ready. Total ready: ${playersReady}`);
    if (playersReady === 2) {
        statusElement.textContent = 'Players Ready.';
        startDriftLogTimer();
        loadBtn.disabled = false;
        // Initial UI setup based on default ON state
        handleSyncToggleChange(); // Call handler to set initial state correctly
        console.log("Both players ready. Initial sync state applied.");
    } else if (playersReady < 2) {
        statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
    }
}

// --- MODIFIED `onPlayerStateChange` - Primarily for UI Updates ---
function onPlayerStateChange(event) {
    if (playersReady < 2) return; // Don't do anything if both aren't ready

    const changedPlayer = event.target;
    const newState = event.data;

    // Only update UI based on Player 1's state when sync is ON,
    // or from either player when sync is OFF (though central controls are disabled then)
    if (isSyncGloballyEnabled && changedPlayer === player1) {
        console.log(`P1 State Changed (Sync ON): ${getPlayerStateName(newState)}`);
        updateCentralControllerUI(player1, newState); // Update central UI based on P1
    } else if (!isSyncGloballyEnabled) {
         // Log state changes when sync is off for debugging, but don't act on them for sync
         try {
             const sourceTime = changedPlayer.getCurrentTime();
             console.log(`State Change (Sync OFF) by ${changedPlayer === player1 ? 'P1':'P2'}: ${getPlayerStateName(newState)} @ ${sourceTime.toFixed(2)}s`);
         } catch(e) {/* ignore */}
    }
    // No cross-player sync commands are sent from here when sync is ON.
}

// --- Central Controls Logic ---

// NEW: Enable/Disable the central controls UI
function setCentralControlsEnabled(enabled) {
    if (!centralControlsContainer) return;
    if (enabled) {
        centralControlsContainer.classList.remove('controls-disabled');
        console.log("Central controls ENABLED.");
    } else {
        centralControlsContainer.classList.add('controls-disabled');
        stopUiUpdateTimer(); // Stop UI updates when disabling controls
        console.log("Central controls DISABLED.");
        // Reset UI to default state when disabled
        if(centralPlayPauseBtn) centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
        if(centralSeekBar) centralSeekBar.value = 0;
        if(centralCurrentTime) centralCurrentTime.textContent = "0:00";
        if(centralDuration) centralDuration.textContent = "0:00";
    }
}

// NEW: Update the central controller UI elements based on player state
function updateCentralControllerUI(player, state) {
    if (!player || typeof player.getDuration !== 'function' || typeof player.getCurrentTime !== 'function' || !centralControlsContainer) return;
    if (!isSyncGloballyEnabled) return; // Only update if sync is on

    try {
        const duration = player.getDuration();
        const currentTime = player.getCurrentTime();
        const currentState = state !== undefined ? state : player.getPlayerState(); // Use passed state if available

        // Update Seek Bar
        if (centralSeekBar) {
            centralSeekBar.max = duration;
            // Only update value if user isn't currently dragging it
            if (!centralSeekBar.matches(':active')) {
                 centralSeekBar.value = currentTime;
            }
        }
        // Update Time Displays
        if (centralCurrentTime) centralCurrentTime.textContent = formatTime(currentTime);
        if (centralDuration) centralDuration.textContent = formatTime(duration);

        // Update Play/Pause Button Icon & Start/Stop UI Timer
        if (centralPlayPauseBtn) {
            if (currentState === YT.PlayerState.PLAYING) {
                centralPlayPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                centralPlayPauseBtn.title = "Pause";
                startUiUpdateTimer(); // Ensure timer is running
            } else {
                centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                centralPlayPauseBtn.title = "Play";
                stopUiUpdateTimer(); // Stop timer when not playing
            }
        }
    } catch (e) {
        console.warn("Error updating central controller UI:", e);
        stopUiUpdateTimer(); // Stop timer on error
    }
}

// NEW: Start the UI update timer
function startUiUpdateTimer() {
    if (uiUpdateInterval) return; // Already running
    stopUiUpdateTimer(); // Clear existing just in case
    console.log("Starting UI update timer.");
    uiUpdateInterval = setInterval(() => {
        if (player1 && isSyncGloballyEnabled) {
            updateCentralControllerUI(player1); // Update based on current P1 time
        } else {
            stopUiUpdateTimer(); // Stop if player gone or sync off
        }
    }, UI_UPDATE_INTERVAL_MS);
}

// NEW: Stop the UI update timer
function stopUiUpdateTimer() {
    if (uiUpdateInterval) {
        console.log("Stopping UI update timer.");
        clearInterval(uiUpdateInterval);
        uiUpdateInterval = null;
    }
}

// --- Event Listeners Setup ---
function setupButtonListeners() {
    // Load Videos
    if (loadBtn) { loadBtn.onclick = loadVideos; console.log("Load Videos listener attached."); }
    else { console.error("Load Videos button not found!"); }

    // Toggle View
    if (toggleViewBtn && mainContainer) {
        toggleViewBtn.onclick = () => {
            mainContainer.classList.toggle('controls-hidden');
            document.body.classList.toggle('fullscreen-active');
            const isHidden = mainContainer.classList.contains('controls-hidden');
            toggleViewBtn.innerHTML = isHidden ? '<i class="fas fa-eye"></i> Show Controls' : '<i class="fas fa-eye-slash"></i> Hide Controls';
            toggleViewBtn.title = isHidden ? "Show Controls View" : "Hide Controls View";
            toggleViewBtn.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
            window.dispatchEvent(new Event('resize'));
        };
        console.log("Toggle view listener attached.");
    } else { console.warn("Toggle view button or main container not found."); }

    // Sync Toggle
    if (syncToggleCheckbox) {
        syncToggleCheckbox.onchange = handleSyncToggleChange; // Use named handler
        console.log("Sync toggle listener attached.");
    } else { console.warn("Sync toggle checkbox not found."); }

    // --- NEW: Central Controller Listeners ---
    if (centralPlayPauseBtn) {
        centralPlayPauseBtn.onclick = () => {
            if (!player1 || !player2 || !isSyncGloballyEnabled) return;
            try {
                const state = player1.getPlayerState();
                if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
                    console.log("Central Control: Pausing both players.");
                    player1.pauseVideo();
                    player2.pauseVideo();
                    // Optimistic UI update
                    centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                    centralPlayPauseBtn.title = "Play";
                } else {
                    console.log("Central Control: Playing both players.");
                    player1.playVideo();
                    player2.playVideo();
                    // Optimistic UI update
                    centralPlayPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                    centralPlayPauseBtn.title = "Pause";
                }
            } catch (e) {
                console.error("Error handling central play/pause:", e);
            }
        };
        console.log("Central play/pause listener attached.");
    } else { console.warn("Central play/pause button not found."); }

    if (centralSeekBar) {
        // 'input' event fires continuously while dragging
        centralSeekBar.addEventListener('input', () => {
             if (!player1 || !isSyncGloballyEnabled) return;
             // Only update the time display while dragging, don't seek yet
             if (centralCurrentTime) {
                 centralCurrentTime.textContent = formatTime(parseFloat(centralSeekBar.value));
             }
        });
         // 'change' event fires when the user releases the mouse
        centralSeekBar.addEventListener('change', () => {
            if (!player1 || !player2 || !isSyncGloballyEnabled) return;
            try {
                const seekTimeP1 = parseFloat(centralSeekBar.value);
                const seekTimeP2 = seekTimeP1 + syncOffsetSeconds;
                console.log(`Central Control: Seeking P1 to ${seekTimeP1.toFixed(2)}s, P2 to ${seekTimeP2.toFixed(2)}s`);

                // Maybe pause briefly before seeking for better sync? Optional.
                // player1.pauseVideo(); player2.pauseVideo();

                player1.seekTo(seekTimeP1, true);
                player2.seekTo(Math.max(0, seekTimeP2), true); // Ensure P2 doesn't seek < 0

                // If paused, seeking keeps it paused. If playing, seeking might buffer then play.
                // Optional: force play after seek if it was playing before?
                // setTimeout(() => { if (player1.getPlayerState() !== YT.PlayerState.PLAYING) { player1.playVideo(); player2.playVideo(); } }, 200);
            } catch (e) {
                 console.error("Error handling central seek:", e);
            }
        });
        console.log("Central seek bar listeners attached.");
    } else { console.warn("Central seek bar not found."); }

    if (centralSkipForwardBtn) {
        centralSkipForwardBtn.onclick = () => handleSkip(5); // Skip forward 5 seconds
        console.log("Central skip forward listener attached.");
    } else { console.warn("Central skip forward button not found."); }

    if (centralSkipBackwardBtn) {
        centralSkipBackwardBtn.onclick = () => handleSkip(-5); // Skip backward 5 seconds
        console.log("Central skip backward listener attached.");
    } else { console.warn("Central skip backward button not found."); }
}

// NEW: Handler for Sync Toggle Change
function handleSyncToggleChange() {
    isSyncGloballyEnabled = syncToggleCheckbox.checked;
    console.log("Global Sync Enabled Toggled:", isSyncGloballyEnabled);

    if (!player1 || !player2 || playersReady < 2) {
        // If players aren't ready, just disable controls and update status
        setCentralControlsEnabled(false);
        updateSyncStatusMessage();
        return;
    }

    if (!isSyncGloballyEnabled) {
        // --- Actions when DISABLING sync ---
        setCentralControlsEnabled(false); // Disable central UI
        // Native controls become usable again (as we didn't disable them forcefully)
        console.log("Sync Disabled: Central controls disabled. Native controls usable.");
    } else {
        // --- Actions when RE-ENABLING sync ---
        console.log("Sync Re-enabled: Calculating offset, enabling central controls.");
        try {
            const time1 = player1.getCurrentTime();
            const time2 = player2.getCurrentTime();
            syncOffsetSeconds = time2 - time1; // Store the NEW offset
            console.log(`  - Calculated Offset (P2 - P1): ${syncOffsetSeconds.toFixed(2)}s`);

            // Ensure players are paused at the correct offset when enabling sync
            // This prevents immediate drift if one was playing and the other wasn't.
             console.log("  - Pausing both players to apply initial sync state.");
             player1.pauseVideo();
             player2.pauseVideo();
             // Seek P2 just in case to ensure offset is applied visually immediately
             const targetP2Time = time1 + syncOffsetSeconds;
             player2.seekTo(Math.max(0, targetP2Time), true);


            setCentralControlsEnabled(true); // Enable central UI
             // Update UI immediately based on current (now paused) state
             setTimeout(() => updateCentralControllerUI(player1, YT.PlayerState.PAUSED), 50); // Slight delay for pause to register

        } catch (e) {
            console.warn("Error setting up sync state on re-enable:", e);
            syncOffsetSeconds = 0;
            setCentralControlsEnabled(false); // Disable controls if error
        }
    }
    updateSyncStatusMessage();
}


// NEW: Handler for Skip Buttons
function handleSkip(secondsToSkip) {
     if (!player1 || !player2 || !isSyncGloballyEnabled) return;
     try {
         const currentTimeP1 = player1.getCurrentTime();
         const durationP1 = player1.getDuration();
         const seekTimeP1 = Math.max(0, Math.min(durationP1, currentTimeP1 + secondsToSkip)); // Clamp within bounds
         const seekTimeP2 = seekTimeP1 + syncOffsetSeconds;

         console.log(`Central Control: Skipping ${secondsToSkip}s. Seeking P1 to ${seekTimeP1.toFixed(2)}s, P2 to ${seekTimeP2.toFixed(2)}s`);

         player1.seekTo(seekTimeP1, true);
         player2.seekTo(Math.max(0, seekTimeP2), true); // Clamp P2 as well

         // Update UI immediately
         if(centralSeekBar) centralSeekBar.value = seekTimeP1;
         if(centralCurrentTime) centralCurrentTime.textContent = formatTime(seekTimeP1);

     } catch (e) {
         console.error(`Error handling skip (${secondsToSkip}s):`, e);
     }
}

// --- Drift Monitoring Logic (Periodic Logging - KEPT) ---
function logDrift() { /* ... unchanged ... */
     if (playersReady < 2 || !player1 || !player2 || typeof player1.getCurrentTime !== 'function' || typeof player2.getCurrentTime !== 'function') { return; }
    try {
        const time1 = player1.getCurrentTime(); const time2 = player2.getCurrentTime();
        const actualOffset = time2 - time1; const drift = actualOffset - syncOffsetSeconds;
        console.log( `Drift Monitor | P1: ${time1.toFixed(3)}s | P2: ${time2.toFixed(3)}s | Actual Offset: ${actualOffset.toFixed(3)}s | Expected Offset: ${syncOffsetSeconds.toFixed(3)}s | Drift: ${drift.toFixed(3)}s` );
    } catch (e) { console.warn("Error during drift logging:", e); }
}
function startDriftLogTimer() { /* ... unchanged ... */
    if (driftLogInterval) return; stopDriftLogTimer();
    console.log(`Starting drift monitor log timer (Interval: ${DRIFT_LOG_INTERVAL_MS}ms)`);
    driftLogInterval = setInterval(logDrift, DRIFT_LOG_INTERVAL_MS);
}
function stopDriftLogTimer() { /* ... unchanged ... */
    if (driftLogInterval) { console.log("Stopping drift monitor log timer."); clearInterval(driftLogInterval); driftLogInterval = null; }
}

// --- UI Interaction Logic ---
function updateSyncStatusMessage() { /* ... unchanged ... */
     if (!statusElement) return;
    // Prevent overwriting API load/error messages
    if (playersReady < 2 && (statusElement.textContent.includes("Loading") || statusElement.textContent.includes("Error"))) return;
    if (isSyncGloballyEnabled) {
        let offsetMsg = "";
        if (Math.abs(syncOffsetSeconds) > 0.1) {
           const sign = syncOffsetSeconds > 0 ? "+" : "";
           offsetMsg = ` (Offset: P2 ${sign}${syncOffsetSeconds.toFixed(2)}s)`;
        }
        statusElement.textContent = `Sync Enabled: Central controls active.${offsetMsg}`;
    } else {
        statusElement.textContent = 'Sync Disabled: Use individual player controls. Re-enable sync to use central controls and set offset.';
    }
}

// --- Initial Setup on DOM Load ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded. Setting up initial state and listeners.");

    if (loadBtn) { loadBtn.disabled = true; }
    if (mainContainer) mainContainer.classList.remove('controls-hidden');
    document.body.classList.remove('fullscreen-active');
    if (toggleViewBtn) { /* ... set initial state ... */
         toggleViewBtn.innerHTML = '<i class="fas fa-eye-slash"></i> Hide Controls';
         toggleViewBtn.title = "Hide Controls View";
         toggleViewBtn.setAttribute('aria-pressed', 'false');
    }
    isSyncGloballyEnabled = true; syncOffsetSeconds = 0;
    if (syncToggleCheckbox) { syncToggleCheckbox.checked = true; }
    setCentralControlsEnabled(false); // Ensure controls start disabled

    setupButtonListeners();
    updateSyncStatusMessage(); // Initial status
});

console.log("Initial script execution finished. Waiting for DOMContentLoaded and YouTube API Ready...");