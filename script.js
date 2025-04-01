// --- Global Variables & DOM References ---
let player1 = null;
let player2 = null;
let playersReady = 0; // Counter for ready players
let isSyncing = false; // Flag to prevent event loops/re-entrancy

const statusElement = document.getElementById('status');
const loadBtn = document.getElementById('loadVideosBtn');
const videoId1Input = document.getElementById('videoId1');
const videoId2Input = document.getElementById('videoId2');
const toggleViewBtn = document.getElementById('toggleViewBtn'); // Ref for toggle button
const mainContainer = document.querySelector('.main-container'); // Ref for main container

// --- Sync State Variables ---
let syncInterval = null; // Interval timer for periodic drift checks
const SYNC_THRESHOLD_DRIFT = 1.0; // Max allowed time difference (seconds) for background drift correction
const SYNC_THRESHOLD_SEEK = 0.5; // Max allowed time diff (seconds) in PLAYING handler before forcing a seek
const SYNC_INTERVAL_MS = 1500; // How often (ms) to check for drift
let syncTimeout = null; // Timeout handle for resetting the isSyncing flag


// --- Helper function to extract Video ID ---
/**
 * Extracts YouTube video ID from various URL formats or returns the input if it looks like an ID.
 * @param {string} input - The user input (URL or ID).
 * @returns {string|null} The extracted video ID or null if invalid.
 */
function extractVideoId(input) {
    if (!input) return null;
    input = input.trim();

    const urlRegex = /(?:watch\?v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/;
    const match = input.match(urlRegex);

    if (match && match[1]) {
        return match[1]; // Return the captured ID from URL
    }

    const plainIdRegex = /^[a-zA-Z0-9_-]{11}$/;
    if (plainIdRegex.test(input)) {
         return input; // Return the input itself as the ID
    }

    console.warn(`Could not extract valid video ID from input: "${input}"`);
    return null; // Could not extract a valid ID
}


// --- YouTube IFrame API Setup ---

// 1. API Ready Callback
window.onYouTubeIframeAPIReady = function() {
    statusElement.textContent = 'API Loaded. Enter Video URLs/IDs and click "Load Videos".';
    loadBtn.disabled = false;
    // loadBtn listener moved to setupToggleViewLogic to ensure button exists
};


// --- Core Player Logic ---

// 2. Load Videos Function
function loadVideos() {
    const input1 = videoId1Input.value;
    const input2 = videoId2Input.value;

    const videoId1 = extractVideoId(input1);
    const videoId2 = extractVideoId(input2);

    let errorMessages = [];
    if (!videoId1) errorMessages.push('Invalid URL or ID for Left Video.');
    if (!videoId2) errorMessages.push('Invalid URL or ID for Right Video.');

    if (errorMessages.length > 0) {
        statusElement.textContent = errorMessages.join(' ');
        videoId1Input.focus();
        return;
    }

    statusElement.textContent = 'Loading videos...';
    loadBtn.disabled = true; // Disable load button while loading

    // Reset state fully
    playersReady = 0;
    isSyncing = false;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    stopSyncTimer();
    destroyPlayers(); // Destroy previous players before creating new ones

    try {
        player1 = new YT.Player('player1', {
            height: '360', width: '640', videoId: videoId1,
            playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });

        player2 = new YT.Player('player2', {
            height: '360', width: '640', videoId: videoId2,
            playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });
    } catch (error) {
        console.error("Error creating YouTube players:", error);
        statusElement.textContent = "Error loading players. Check console.";
        // Don't re-enable loadBtn here, let user try again manually if desired
    }
}

// 3. Destroy Players Function
function destroyPlayers() {
    stopSyncTimer();
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    isSyncing = false;

    if (player1 && typeof player1.destroy === 'function') {
        try { player1.destroy(); } catch (e) { console.warn("Error destroying player1:", e); }
        player1 = null;
    }
    if (player2 && typeof player2.destroy === 'function') {
        try { player2.destroy(); } catch (e) { console.warn("Error destroying player2:", e); }
        player2 = null;
    }
    // Ensure placeholders are cleared reliably
    document.getElementById('player1').innerHTML = '';
    document.getElementById('player2').innerHTML = '';
}

// 4. Player Ready Handler
function onPlayerReady(event) {
    playersReady++;
    if (playersReady === 2) {
        statusElement.textContent = 'Players Ready. Controls are synced.';
        loadBtn.disabled = false; // Re-enable button only when BOTH players are ready
    } else if (playersReady < 2) {
        statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
    }
    // If > 2 (shouldn't happen with destroy logic), might indicate an issue
}

// 5. Player State Change Handler
function onPlayerStateChange(event) {
    if (isSyncing || playersReady < 2 || !player1 || !player2) {
        return;
    }

    const sourcePlayer = event.target;
    const targetPlayer = (sourcePlayer === player1) ? player2 : player1;

    if (!targetPlayer || typeof targetPlayer.getPlayerState !== 'function') {
        console.warn("Target player not available during state change.");
        return;
    }

    let newState = -99; // Default invalid state
    let sourceTime = 0;
    try {
        newState = event.data;
        sourceTime = sourcePlayer.getCurrentTime();
    } catch(e) {
        console.warn("Error getting state or time from source player:", e);
        return; // Don't sync if we can't get reliable info
    }

    // const sourceName = (sourcePlayer === player1) ? "P1" : "P2";
    // console.log(`State Change Event: ${sourceName} -> ${newState} @ ${sourceTime.toFixed(2)}s`);

    setSyncing(true); // LOCK
    syncTargetPlayer(targetPlayer, sourcePlayer, newState, sourceTime);
    clearSyncingTimeout(250); // UNLOCK after delay
}

// 6. Core Synchronization Logic
function syncTargetPlayer(targetPlayer, sourcePlayer, sourceState, sourceTime) {
    if (!targetPlayer || !sourcePlayer) return; // Redundant safety check

    let targetState = -99;
    try {
        targetState = targetPlayer.getPlayerState();
    } catch(e) {
        console.warn("Error getting target player state:", e);
        return; // Cannot sync if target state is unknown
    }

    // console.log(`SYNC FUNCTION: Target=${targetPlayer === player1 ? 'P1' : 'P2'}, SourceState=${sourceState}, TargetState=${targetState}, SourceTime=${sourceTime.toFixed(2)}`);

    try { // Wrap API calls in try-catch
        switch (sourceState) {
            case YT.PlayerState.PLAYING:
                let targetTime = 0;
                try { targetTime = targetPlayer.getCurrentTime(); }
                catch (e) { /* If error getting time, proceed to seek/play */ }

                const timeDiff = Math.abs(sourceTime - targetTime);
                // console.log(`SYNC - PLAYING: Diff=${timeDiff.toFixed(2)}`);

                if (timeDiff > SYNC_THRESHOLD_SEEK) {
                    // console.log(`SYNC - PLAYING: Seeking target`);
                    targetPlayer.seekTo(sourceTime, true);
                }
                if (targetState !== YT.PlayerState.PLAYING) {
                    // console.log(`SYNC - PLAYING: Calling playVideo()`);
                    targetPlayer.playVideo();
                }
                startSyncTimer(); // Ensure timer runs
                break;

            case YT.PlayerState.PAUSED:
                stopSyncTimer();
                if (targetState !== YT.PlayerState.PAUSED) {
                    targetPlayer.pauseVideo();
                }
                // Seek slightly after pause command for robustness
                setTimeout(() => {
                    if (playersReady === 2 && targetPlayer && typeof targetPlayer.seekTo === 'function') {
                        try {
                            // Check state *again* before seeking
                            if(targetPlayer.getPlayerState() === YT.PlayerState.PAUSED){
                                targetPlayer.seekTo(sourceTime, true);
                                // console.log(`SYNC - PAUSED - Seek executed after delay`);
                            }
                        } catch (e) { console.warn("Error seeking in pause timeout:", e); }
                    }
                }, 100);
                break;

            case YT.PlayerState.BUFFERING:
                stopSyncTimer();
                if (targetState !== YT.PlayerState.PAUSED && targetState !== YT.PlayerState.BUFFERING) {
                    // console.log("SYNC - BUFFERING: Pausing target");
                    targetPlayer.pauseVideo();
                }
                break;

            case YT.PlayerState.ENDED:
                // console.log("SYNC - ENDED: Pausing target");
                stopSyncTimer();
                 if (targetState !== YT.PlayerState.PAUSED) {
                     targetPlayer.pauseVideo();
                 }
                // Seek target to end time (sourceTime should be duration or close)
                try { targetPlayer.seekTo(sourceTime, true); }
                catch(e) { console.warn("Error seeking on ENDED state:", e); }
                break;
        }
    } catch (error) {
        console.error("Error during syncTargetPlayer action:", error);
        // Potentially stop sync timer or reset state if errors persist
    }
}

// --- Sync Timer Logic ---
function startSyncTimer() {
    stopSyncTimer(); // Clear existing timer first
    // console.log("Starting sync timer");
    syncInterval = setInterval(checkAndSyncTime, SYNC_INTERVAL_MS);
}

function stopSyncTimer() {
    if (syncInterval) {
        // console.log("Stopping sync timer");
        clearInterval(syncInterval);
        syncInterval = null;
    }
}

function checkAndSyncTime() {
     if (isSyncing || playersReady < 2 || !player1 || !player2) {
        return; // Don't run if busy, not ready, or players destroyed
    }

    try {
        const state1 = player1.getPlayerState();
        const state2 = player2.getPlayerState();

        if (state1 === YT.PlayerState.PLAYING && state2 === YT.PlayerState.PLAYING) {
            const time1 = player1.getCurrentTime();
            const time2 = player2.getCurrentTime();
            const diff = Math.abs(time1 - time2);

            if (diff > SYNC_THRESHOLD_DRIFT) {
                // console.log(`Drift Check: Syncing P2->P1. Diff=${diff.toFixed(2)}`);
                setSyncing(true); // LOCK
                player2.seekTo(time1, true); // Sync P2 to P1's time
                clearSyncingTimeout(150); // UNLOCK after short delay
            }
        } else {
            // If players are not both playing, the timer isn't needed.
             stopSyncTimer();
        }
    } catch (e) {
        console.warn("Error during sync check:", e);
        stopSyncTimer(); // Stop timer if players error out
    }
}

// --- Helper functions for isSyncing flag ---
function setSyncing(status) {
    // console.log(`Setting isSyncing to: ${status}`);
    isSyncing = status;
    // If we are starting to sync, clear any pending unlock timeout
    if (status && syncTimeout) {
         clearTimeout(syncTimeout);
         syncTimeout = null;
    }
}

function clearSyncingTimeout(delay = 250) {
    // Clear any existing timeout first
    if (syncTimeout) clearTimeout(syncTimeout);
    // Set a new timeout to unlock
    syncTimeout = setTimeout(() => {
        // console.log("Resetting isSyncing via timeout");
        isSyncing = false;
        syncTimeout = null;
    }, delay);
}

// --- UI Interaction Logic ---

function setupToggleViewLogic() {
    // Setup Load Button Listener (moved here to ensure button exists)
     if (loadBtn) {
        loadBtn.onclick = loadVideos;
    } else {
        console.error("Load Videos button not found!");
    }

    // Setup Toggle Button Listener
    if (toggleViewBtn && mainContainer) {
        toggleViewBtn.onclick = () => {
            mainContainer.classList.toggle('controls-hidden');
            const isHidden = mainContainer.classList.contains('controls-hidden');
            if (isHidden) {
                toggleViewBtn.innerHTML = '<i class="fas fa-eye"></i> Show Controls';
                toggleViewBtn.title = "Show Controls View";
            } else {
                toggleViewBtn.innerHTML = '<i class="fas fa-eye-slash"></i> Hide Controls';
                toggleViewBtn.title = "Hide Controls View";
            }
        };
        // Ensure controls are visible initially
        mainContainer.classList.remove('controls-hidden');
    } else {
        console.warn("Toggle view button or main container not found.");
    }
}

// --- Initial Setup ---
document.addEventListener('DOMContentLoaded', () => {
    // Initial button state (disabled until API ready)
    if (loadBtn) {
        loadBtn.disabled = true;
    }
    // Set up button listeners after DOM is loaded
    setupToggleViewLogic();
});