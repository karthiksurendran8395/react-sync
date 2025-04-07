// --- Global Variables & DOM References ---
const statusElement = document.getElementById('status');
const loadBtn = document.getElementById('loadVideosBtn');
const videoId1Input = document.getElementById('videoId1');
const videoId2Input = document.getElementById('videoId2');
const toggleViewBtn = document.getElementById('toggleViewBtn');
const mainContainer = document.querySelector('.main-container');
const syncToggleCheckbox = document.getElementById('syncToggleCheckbox');

// Player instances
let player1 = null;
let player2 = null;
let playersReady = 0;
let isSyncing = false; // Internal flag for preventing event loops

// --- Sync State Variables ---
let isSyncGloballyEnabled = true; // Master switch for sync controls
let syncOffsetSeconds = 0; // Stores the time difference (P2 time - P1 time)
// REMOVED: syncInterval = null; // Timer for *correcting* drift
// REMOVED: const SYNC_THRESHOLD_DRIFT = 1.0; // Max allowed drift (seconds) before correction during playback
const SYNC_THRESHOLD_SEEK = 0.5; // Max allowed diff (seconds) before seeking on play/pause
// REMOVED: const SYNC_INTERVAL_MS = 1500; // How often to check for drift (milliseconds)
let syncTimeout = null; // Timeout handle for releasing the isSyncing lock

// --- Drift Monitoring Variables (KEPT) ---
let driftLogInterval = null; // Timer for *logging* drift
const DRIFT_LOG_INTERVAL_MS = 2000; // Log every 2 seconds

// --- Helper function to extract Video ID ---
function extractVideoId(input) {
    if (!input) return null;
    input = input.trim();
    // Regex for standard watch URLs, short youtu.be URLs, and embed URLs
    const urlRegex = /(?:watch\?v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/;
    const match = input.match(urlRegex);
    if (match && match[1]) { return match[1]; }
    // Regex for just the plain 11-character ID
    const plainIdRegex = /^[a-zA-Z0-9_-]{11}$/;
    if (plainIdRegex.test(input)) { return input; }
    console.warn(`Could not extract valid video ID from input: "${input}"`);
    return null;
}

// --- YouTube IFrame API Setup ---
window.onYouTubeIframeAPIReady = function() {
    console.log("YouTube IFrame API Ready");
    if (statusElement) statusElement.textContent = 'API Loaded. Enter Video URLs/IDs and click "Load Videos".';
    if (loadBtn) {
        loadBtn.disabled = false; // Enable the button now that the API is ready
        console.log("Load Videos button enabled.");
    } else {
        console.error("Load button not found when API ready!");
    }
};

// --- Core Player Logic ---

// Function to load or reload videos based on input fields
function loadVideos() {
    console.log("loadVideos function called.");
    if (!videoId1Input || !videoId2Input || !statusElement || !loadBtn || !syncToggleCheckbox) {
        console.error("Required elements missing for loadVideos.");
        if (statusElement) statusElement.textContent = "Error: UI elements missing.";
        return;
    }

    const videoId1 = extractVideoId(videoId1Input.value);
    const videoId2 = extractVideoId(videoId2Input.value);

    let errorMessages = [];
    if (!videoId1) errorMessages.push('Invalid URL or ID for Left Video.');
    if (!videoId2) errorMessages.push('Invalid URL or ID for Right Video.');
    if (errorMessages.length > 0) {
        statusElement.textContent = errorMessages.join(' ');
        if (!videoId1) videoId1Input.focus(); else videoId2Input.focus();
        return;
    }

    console.log("Loading videos with IDs:", videoId1, videoId2);
    statusElement.textContent = 'Loading videos...';
    loadBtn.disabled = true;

    // --- Reset State Before Loading New Videos ---
    playersReady = 0;
    isSyncing = false;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    // REMOVED: stopSyncTimer(); // Stop correction timer
    stopDriftLogTimer(); // Stop logging timer
    destroyPlayers(); // Remove existing player instances and iframes
    isSyncGloballyEnabled = true;
    syncOffsetSeconds = 0;
    syncToggleCheckbox.checked = true;
    console.log("State reset for load: Global Sync ON, Offset 0s");
    // --- End Reset State ---

    try {
        player1 = new YT.Player('player1', {
            height: '360',
            width: '640',
            videoId: videoId1,
            playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });
        player2 = new YT.Player('player2', {
            height: '360',
            width: '640',
            videoId: videoId2,
            playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });
    } catch (error) {
        console.error("Error creating YouTube players:", error);
        if (statusElement) statusElement.textContent = "Error loading players. Check console.";
        if(loadBtn) loadBtn.disabled = false;
    }
}

// Function to properly destroy existing player instances
function destroyPlayers() {
    console.log("Destroying existing players...");
    // REMOVED: stopSyncTimer(); // Stop correction timer
    stopDriftLogTimer(); // Stop logging timer
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    isSyncing = false;

    if (player1 && typeof player1.destroy === 'function') {
        try { player1.destroy(); } catch (e) { console.warn("Error destroying player1:", e)}
        player1 = null;
    }
    if (player2 && typeof player2.destroy === 'function') {
        try { player2.destroy(); } catch (e) { console.warn("Error destroying player2:", e)}
        player2 = null;
    }

    const p1Element = document.getElementById('player1');
    const p2Element = document.getElementById('player2');
    if (p1Element) p1Element.innerHTML = '';
    if (p2Element) p2Element.innerHTML = '';
}

// Event handler called when a player is ready to be controlled
function onPlayerReady(event) {
    playersReady++;
    const playerName = event.target === player1 ? "Player 1 (Left)" : "Player 2 (Right)";
    console.log(`${playerName} is Ready. Total ready: ${playersReady}`);

    if (playersReady === 2) {
        if (statusElement) statusElement.textContent = 'Players Ready.';
        updateSyncStatusMessage();
        startDriftLogTimer(); // Start logging timer when both players ready
        if (loadBtn) {
            loadBtn.disabled = false;
            console.log("Load button re-enabled (both players ready).");
        }
    } else if (playersReady < 2) {
        if (statusElement) statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
    }
}

// Event handler called when a player's state changes (playing, paused, etc.) - Reactive Sync
function onPlayerStateChange(event) {
    // --- Guard Clauses: Exit early if conditions aren't met ---
    if (!isSyncGloballyEnabled) {
        // No sync actions if disabled, but log state changes for info
        try {
             const newState = event.data;
             const sourcePlayer = event.target;
             const sourceTime = sourcePlayer.getCurrentTime();
             console.log(`State Change (Sync OFF) by ${sourcePlayer === player1 ? 'P1':'P2'}: ${getPlayerStateName(newState)} @ ${sourceTime.toFixed(2)}s`);
        } catch(e) {/* ignore errors here */}
        return; // Do not proceed with synchronization
    }
    if (isSyncing) { return; }
    if (playersReady < 2) { return; }
    if (!player1 || !player2) { return; }
    // --- End Guard Clauses ---

    const sourcePlayer = event.target;
    const targetPlayer = (sourcePlayer === player1) ? player2 : player1;

    if (!targetPlayer || typeof targetPlayer.getPlayerState !== 'function') {
        console.warn("Target player not available or invalid during state change."); return;
    }

    let newState = -99, sourceTime = 0;
    try {
        newState = event.data;
        sourceTime = sourcePlayer.getCurrentTime();
        console.log(`State Change (Sync ON) by ${sourcePlayer === player1 ? 'P1':'P2'}: ${getPlayerStateName(newState)} @ ${sourceTime.toFixed(2)}s`);
    } catch(e) {
        console.warn(`Error getting state or time from source player:`, e); return;
    }

    // --- Start Synchronization Process ---
    setSyncing(true); // *** LOCK ***
    syncTargetPlayer(targetPlayer, sourcePlayer, newState, sourceTime, syncOffsetSeconds);
    clearSyncingTimeout(250); // *** UNLOCK (Delayed) ***
    // --- End Synchronization Process ---
}

// Helper function to get the string name of a player state code
function getPlayerStateName(stateCode) {
    for (const state in YT.PlayerState) {
        if (YT.PlayerState[state] === stateCode) { return state; }
    }
    return `UNKNOWN (${stateCode})`;
}

// Core function to synchronize the target player based on the source player's action (Reactive Sync)
function syncTargetPlayer(targetPlayer, sourcePlayer, sourceState, sourceTime, offset) {
    if (!targetPlayer || typeof targetPlayer.getPlayerState !== 'function' || !sourcePlayer) {
        console.warn("Sync aborted: Invalid players provided to syncTargetPlayer."); return;
    }

    let targetState = -99;
    try {
        targetState = targetPlayer.getPlayerState();
    } catch(e) {
        console.warn("Sync aborted: Error getting target player state:", e); return;
    }

    const targetName = targetPlayer === player1 ? "P1" : "P2";
    let targetSeekTime;

    try {
        switch (sourceState) {
            case YT.PlayerState.PLAYING:
                if (sourcePlayer === player1) { targetSeekTime = sourceTime + offset; }
                else { targetSeekTime = sourceTime - offset; }

                let currentTargetTime = 0; try { currentTargetTime = targetPlayer.getCurrentTime(); } catch (e) {}
                const timeDiffPlaying = Math.abs(currentTargetTime - targetSeekTime);

                if (timeDiffPlaying > SYNC_THRESHOLD_SEEK) {
                    console.log(`Syncing ${targetName} seek to ${targetSeekTime.toFixed(2)}s (Diff: ${timeDiffPlaying.toFixed(2)}s > ${SYNC_THRESHOLD_SEEK})`);
                    targetPlayer.seekTo(targetSeekTime, true);
                }

                if (targetState !== YT.PlayerState.PLAYING && targetState !== YT.PlayerState.BUFFERING) {
                    console.log(`Syncing ${targetName} playVideo`);
                    targetPlayer.playVideo();
                }
                // REMOVED: startSyncTimer(); // No longer start drift correction timer
                break;

            case YT.PlayerState.PAUSED:
                // REMOVED: stopSyncTimer(); // No drift correction timer to stop
                if (targetState !== YT.PlayerState.PAUSED) {
                    console.log(`Syncing ${targetName} pauseVideo`);
                    targetPlayer.pauseVideo();
                }

                if (sourcePlayer === player1) { targetSeekTime = sourceTime + offset; }
                else { targetSeekTime = sourceTime - offset; }

                setTimeout(() => {
                    if (playersReady === 2 && targetPlayer && typeof targetPlayer.seekTo === 'function') {
                        try {
                            // Check state *again* within the timeout
                            if(targetPlayer.getPlayerState() === YT.PlayerState.PAUSED){
                                console.log(`Syncing ${targetName} seek (post-pause) to ${targetSeekTime.toFixed(2)}s`);
                                targetPlayer.seekTo(targetSeekTime, true);
                            } else {
                                console.log(`Skipped post-pause seek for ${targetName}, state was not PAUSED.`);
                            }
                        } catch (e) { console.warn(`Error seeking ${targetName} in pause timeout:`, e); }
                    }
                }, 150);
                break;

            case YT.PlayerState.BUFFERING:
                 // REMOVED: stopSyncTimer();
                if (targetState === YT.PlayerState.PLAYING) {
                    console.log(`Syncing ${targetName} pauseVideo (due to source buffering)`);
                    targetPlayer.pauseVideo();
                }
                break;

            case YT.PlayerState.ENDED:
                // REMOVED: stopSyncTimer();
                if (targetState !== YT.PlayerState.PAUSED && targetState !== YT.PlayerState.ENDED) {
                     console.log(`Syncing ${targetName} pauseVideo (due to source ended)`);
                    targetPlayer.pauseVideo();
                }
                try {
                    if (sourcePlayer === player1) { targetSeekTime = sourceTime + offset; }
                    else { targetSeekTime = sourceTime - offset; }
                    // Check state before seeking on ENDED as well
                     if (playersReady === 2 && targetPlayer && typeof targetPlayer.getPlayerState === 'function') { // Add ready check
                        let currentTargetStateOnEnd = targetPlayer.getPlayerState();
                        if(currentTargetStateOnEnd === YT.PlayerState.PAUSED || currentTargetStateOnEnd === YT.PlayerState.ENDED){
                            console.log(`Syncing ${targetName} seek (post-end) to ${targetSeekTime.toFixed(2)}s`);
                            targetPlayer.seekTo(targetSeekTime, true);
                        } else {
                            console.log(`Skipped post-end seek for ${targetName}, state was not PAUSED/ENDED.`);
                        }
                    }
                } catch(e) { console.warn(`Error seeking ${targetName} on ENDED state:`, e); }
                break;

             case YT.PlayerState.CUED:
                 // REMOVED: stopSyncTimer();
                 if (targetState === YT.PlayerState.PLAYING) {
                     console.log(`Syncing ${targetName} pauseVideo (due to source cued)`);
                     targetPlayer.pauseVideo();
                 }
                 break;
        }
    } catch (error) {
        console.error(`Error during syncTargetPlayer action (State: ${getPlayerStateName(sourceState)}):`, error);
        // REMOVED: stopSyncTimer(); // No timer to stop
    }
}


// --- REMOVED: Sync Timer Logic (Periodic Drift Check & *Correction*) ---
// REMOVED: startSyncTimer() function
// REMOVED: stopSyncTimer() function
// REMOVED: checkAndSyncTime() function


// --- Drift Monitoring Logic (Periodic Logging - KEPT) ---

function logDrift() {
    if (playersReady < 2 || !player1 || !player2 ||
        typeof player1.getCurrentTime !== 'function' || typeof player2.getCurrentTime !== 'function') {
        return;
    }

    try {
        const time1 = player1.getCurrentTime();
        const time2 = player2.getCurrentTime();
        const actualOffset = time2 - time1;
        const drift = actualOffset - syncOffsetSeconds; // Compare against the *currently set* sync offset

        console.log(
            `Drift Monitor | ` +
            `P1: ${time1.toFixed(3)}s | ` +
            `P2: ${time2.toFixed(3)}s | ` +
            `Actual Offset: ${actualOffset.toFixed(3)}s | ` +
            `Expected Offset: ${syncOffsetSeconds.toFixed(3)}s | ` + // Log the offset sync *would* aim for
            `Drift: ${drift.toFixed(3)}s`
        );

    } catch (e) {
        console.warn("Error during drift logging:", e);
        // stopDriftLogTimer(); // Optionally stop if errors persist
    }
}

function startDriftLogTimer() {
    if (driftLogInterval) return;
    stopDriftLogTimer();
    console.log(`Starting drift monitor log timer (Interval: ${DRIFT_LOG_INTERVAL_MS}ms)`);
    driftLogInterval = setInterval(logDrift, DRIFT_LOG_INTERVAL_MS);
}

function stopDriftLogTimer() {
    if (driftLogInterval) {
        console.log("Stopping drift monitor log timer.");
        clearInterval(driftLogInterval);
        driftLogInterval = null;
    }
}

// --- Helper functions for managing the `isSyncing` flag (Internal sync lock) ---

function setSyncing(status) {
    isSyncing = status;
    if (status && syncTimeout) {
        clearTimeout(syncTimeout);
        syncTimeout = null;
    }
    // console.log(`isSyncing set to: ${status}`);
}

function clearSyncingTimeout(delay = 250) {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        // console.log(`isSyncing lock released after ${delay}ms timeout.`);
        isSyncing = false;
        syncTimeout = null;
    }, delay);
}

// --- UI Interaction Logic ---

function updateSyncStatusMessage() {
    if (!statusElement) return;
    if (playersReady < 2 && statusElement.textContent.includes("Loading") || statusElement.textContent.includes("Error")) return;

    if (isSyncGloballyEnabled) {
        let offsetMsg = "";
        if (Math.abs(syncOffsetSeconds) > 0.1) {
           const sign = syncOffsetSeconds > 0 ? "+" : "";
           offsetMsg = ` (Offset: P2 ${sign}${syncOffsetSeconds.toFixed(2)}s)`;
        }
        statusElement.textContent = `Sync Enabled: Playback controls linked.${offsetMsg}`;
    } else {
        statusElement.textContent = 'Sync Disabled: Controls are independent. Adjust videos and re-enable sync to set new offset.';
    }
}

function setupButtonListeners() {
    if (loadBtn) {
        loadBtn.onclick = loadVideos;
        console.log("Load Videos listener attached.");
    } else { console.error("Load Videos button not found!"); }

    if (toggleViewBtn && mainContainer) {
         toggleViewBtn.onclick = () => {
            console.log("Toggle view button clicked.");
            mainContainer.classList.toggle('controls-hidden');
            document.body.classList.toggle('fullscreen-active');

            const isHidden = mainContainer.classList.contains('controls-hidden');
            if (isHidden) {
                toggleViewBtn.innerHTML = '<i class="fas fa-eye"></i> Show Controls';
                toggleViewBtn.title = "Show Controls View";
                toggleViewBtn.setAttribute('aria-pressed', 'true');
            } else {
                toggleViewBtn.innerHTML = '<i class="fas fa-eye-slash"></i> Hide Controls';
                toggleViewBtn.title = "Hide Controls View";
                toggleViewBtn.setAttribute('aria-pressed', 'false');
            }
             window.dispatchEvent(new Event('resize'));
        };
        console.log("Toggle view listener attached.");
    } else { console.warn("Toggle view button or main container not found."); }

    if (syncToggleCheckbox) {
        syncToggleCheckbox.onchange = () => {
            isSyncGloballyEnabled = syncToggleCheckbox.checked;
            console.log("Global Sync Enabled Toggled:", isSyncGloballyEnabled);

            if (!isSyncGloballyEnabled) {
                // --- Actions when DISABLING sync ---
                // REMOVED: stopSyncTimer(); // No correction timer to stop
                console.log("Sync Disabled: Reactive sync stopped.");
                // Drift logging continues regardless.
            } else {
                // --- Actions when RE-ENABLING sync ---
                console.log("Sync Re-enabled: Calculating and storing current time offset...");
                if (playersReady === 2 && player1 && player2 &&
                    typeof player1.getCurrentTime === 'function' && typeof player2.getCurrentTime === 'function') {
                     try {
                         const time1 = player1.getCurrentTime();
                         const time2 = player2.getCurrentTime();
                         syncOffsetSeconds = time2 - time1; // Store the NEW offset
                         console.log(`  - Calculated Offset (P2 - P1): ${syncOffsetSeconds.toFixed(2)}s`);

                         // REMOVED: Logic to restart drift timer based on state
                         // Drift correction timer is gone. Reactive sync will just use the new offset on the next event.

                     } catch (e) {
                         console.warn("Error calculating offset on re-enable:", e);
                         syncOffsetSeconds = 0; // Reset offset on error
                         // REMOVED: stopSyncTimer();
                     }
                } else {
                    console.log("  - Could not calculate offset (players not ready/valid). Offset remains 0.");
                    syncOffsetSeconds = 0;
                    // REMOVED: stopSyncTimer();
                }
            }
            updateSyncStatusMessage();
        };
        console.log("Sync toggle listener attached.");
    } else { console.warn("Sync toggle checkbox not found."); }
}

// --- Initial Setup on DOM Load ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded. Setting up initial state and listeners.");

    if (loadBtn) { loadBtn.disabled = true; }
    if (mainContainer) mainContainer.classList.remove('controls-hidden');
    document.body.classList.remove('fullscreen-active');
    if (toggleViewBtn) {
        toggleViewBtn.innerHTML = '<i class="fas fa-eye-slash"></i> Hide Controls';
        toggleViewBtn.title = "Hide Controls View";
        toggleViewBtn.setAttribute('aria-pressed', 'false');
    }
    isSyncGloballyEnabled = true;
    syncOffsetSeconds = 0;
    if (syncToggleCheckbox) { syncToggleCheckbox.checked = true; }

    setupButtonListeners();
    updateSyncStatusMessage();
});

console.log("Initial script execution finished. Waiting for DOMContentLoaded and YouTube API Ready...");