// Global variables for player instances
let player1 = null;
let player2 = null;
let playersReady = 0; // Counter for ready players
let isSyncing = false; // Flag to prevent event loops/re-entrancy
const statusElement = document.getElementById('status');
const loadBtn = document.getElementById('loadVideosBtn');
const videoId1Input = document.getElementById('videoId1');
const videoId2Input = document.getElementById('videoId2');

// --- Sync State Variables ---
let syncInterval = null; // Interval timer for periodic drift checks
const SYNC_THRESHOLD_DRIFT = 1.0; // Max allowed time difference (seconds) for background drift correction
const SYNC_THRESHOLD_SEEK = 0.5; // Max allowed time diff (seconds) in PLAYING handler before forcing a seek
const SYNC_INTERVAL_MS = 1500; // How often (ms) to check for drift
let syncTimeout = null; // Timeout handle for resetting the isSyncing flag

// --- NEW: Helper function to extract Video ID ---
/**
 * Extracts YouTube video ID from various URL formats or returns the input if it looks like an ID.
 * @param {string} input - The user input (URL or ID).
 * @returns {string|null} The extracted video ID or null if invalid.
 */
function extractVideoId(input) {
    if (!input) return null;
    input = input.trim();

    // Regex to capture video ID from common YouTube URL formats
    // Covers:
    // - youtube.com/watch?v=VIDEO_ID
    // - youtu.be/VIDEO_ID
    // - youtube.com/embed/VIDEO_ID
    // Handles optional parameters after the ID (e.g., &t=, ?si=)
    const urlRegex = /(?:watch\?v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/;
    const match = input.match(urlRegex);

    if (match && match[1]) {
        return match[1]; // Return the captured ID from URL
    }

    // If no URL match, check if the input itself looks like a valid ID
    // Standard YouTube IDs are 11 characters long and use this character set.
    const plainIdRegex = /^[a-zA-Z0-9_-]{11}$/;
    if (plainIdRegex.test(input)) {
         return input; // Return the input itself as the ID
    }

    console.warn(`Could not extract valid video ID from input: "${input}"`);
    return null; // Could not extract a valid ID
}


// 1. API Ready Callback
window.onYouTubeIframeAPIReady = function() {
    statusElement.textContent = 'API Loaded. Enter Video URLs/IDs and click "Load Videos".';
    loadBtn.disabled = false;
    loadBtn.onclick = loadVideos; // Use onclick for simplicity here
};

// 2. Load Videos Function (MODIFIED)
function loadVideos() {
    // Get raw input values
    const input1 = videoId1Input.value;
    const input2 = videoId2Input.value;

    // Extract IDs using the helper function
    const videoId1 = extractVideoId(input1);
    const videoId2 = extractVideoId(input2);

    // Validate extracted IDs
    let errorMessages = [];
    if (!videoId1) {
        errorMessages.push('Invalid URL or ID for Left Video.');
    }
    if (!videoId2) {
        errorMessages.push('Invalid URL or ID for Right Video.');
    }

    if (errorMessages.length > 0) {
        statusElement.textContent = errorMessages.join(' ');
        videoId1Input.focus(); // Focus the first input for convenience
        return;
    }

    // --- Proceed if IDs are valid ---
    statusElement.textContent = 'Loading videos...';
    loadBtn.disabled = true;

    // Reset state fully
    playersReady = 0;
    isSyncing = false;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    stopSyncTimer();
    destroyPlayers();

    // Create Player 1 using the extracted ID
    player1 = new YT.Player('player1', {
        height: '360', width: '640', videoId: videoId1, // Use extracted ID
        playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });

    // Create Player 2 using the extracted ID
    player2 = new YT.Player('player2', {
        height: '360', width: '640', videoId: videoId2, // Use extracted ID
        playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

// 3. Destroy Players Function (No changes needed)
function destroyPlayers() {
    stopSyncTimer();
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    isSyncing = false;

    if (player1 && typeof player1.destroy === 'function') {
        player1.destroy(); player1 = null;
    }
    if (player2 && typeof player2.destroy === 'function') {
        player2.destroy(); player2 = null;
    }
    // Ensure placeholders are cleared even if destroy fails somehow
    document.getElementById('player1').innerHTML = '';
    document.getElementById('player2').innerHTML = '';
}

// 4. Player Ready Handler (No changes needed)
function onPlayerReady(event) {
    playersReady++;
    if (playersReady === 2) {
        statusElement.textContent = 'Players Ready. Controls are synced.';
        loadBtn.disabled = false; // Re-enable button once players are fully ready
    } else {
         statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
    }
}

// 5. Player State Change Handler (No changes needed)
function onPlayerStateChange(event) {
    if (isSyncing || playersReady < 2) {
        return;
    }

    const sourcePlayer = event.target;
    const targetPlayer = (sourcePlayer === player1) ? player2 : player1;
    // Basic safety check in case targetPlayer somehow got destroyed between checks
    if (!targetPlayer || typeof targetPlayer.getPlayerState !== 'function') {
        console.warn("Target player not available during state change.");
        return;
    }
    const newState = event.data;
    const sourceTime = sourcePlayer.getCurrentTime();

    // const sourceName = (sourcePlayer === player1) ? "P1" : "P2";
    // console.log(`State Change Event: ${sourceName} -> ${newState} @ ${sourceTime.toFixed(2)}s`);

    setSyncing(true); // LOCK

    syncTargetPlayer(targetPlayer, sourcePlayer, newState, sourceTime);

    clearSyncingTimeout(250); // UNLOCK after delay
}

// 6. Core Synchronization Logic (No changes needed)
function syncTargetPlayer(targetPlayer, sourcePlayer, sourceState, sourceTime) {
    if (!targetPlayer || !sourcePlayer) return; // Safety check

    const targetState = targetPlayer.getPlayerState();

    // console.log(`SYNC FUNCTION: Target=${targetPlayer === player1 ? 'P1' : 'P2'}, SourceState=${sourceState}, SourceTime=${sourceTime.toFixed(2)}`);

    switch (sourceState) {
        case YT.PlayerState.PLAYING:
            let targetTime = 0;
            try {
                targetTime = targetPlayer.getCurrentTime();
            } catch (e) {
                console.warn("Error getting target time:", e);
                targetPlayer.seekTo(sourceTime, true);
                targetPlayer.playVideo();
                startSyncTimer();
                return;
            }

            const timeDiff = Math.abs(sourceTime - targetTime);
            // console.log(`SYNC - PLAYING: SourceTime=${sourceTime.toFixed(2)}, TargetTime=${targetTime.toFixed(2)}, Diff=${timeDiff.toFixed(2)}`);

            if (timeDiff > SYNC_THRESHOLD_SEEK) {
                 // console.log(`SYNC - PLAYING: Seeking target, diff ${timeDiff.toFixed(2)} > ${SYNC_THRESHOLD_SEEK}`);
                targetPlayer.seekTo(sourceTime, true);
            }
             if (targetState !== YT.PlayerState.PLAYING) {
                 // console.log(`SYNC - PLAYING: Calling playVideo() on target (State was ${targetState})`);
                targetPlayer.playVideo();
             }
            startSyncTimer();
            break;

        case YT.PlayerState.PAUSED:
            stopSyncTimer();
            targetPlayer.pauseVideo();
            setTimeout(() => {
                if (playersReady === 2 && targetPlayer && targetPlayer.getPlayerState && targetPlayer.getPlayerState() === YT.PlayerState.PAUSED) {
                     try {
                        targetPlayer.seekTo(sourceTime, true);
                        // console.log(`SYNC - PAUSED - Seek executed after delay to ${sourceTime.toFixed(2)}`);
                     } catch (e) { console.warn("Error seeking in pause timeout:", e); }
                }
            }, 100);
            break;

        case YT.PlayerState.BUFFERING:
            stopSyncTimer();
            if (targetState !== YT.PlayerState.PAUSED && targetState !== YT.PlayerState.BUFFERING) {
                // console.log("Sync Action: Buffering detected on Source, pausing Target");
                targetPlayer.pauseVideo();
            }
            break;

        case YT.PlayerState.ENDED:
            // console.log("Sync Action: Source Ended, pausing Target");
            stopSyncTimer();
            if (targetState !== YT.PlayerState.PAUSED) {
                 targetPlayer.pauseVideo();
            }
             // Seek target to end time (or source's current time, which should be the end)
            try {
                 targetPlayer.seekTo(sourceTime, true);
            } catch(e) { console.warn("Error seeking on ENDED state:", e); }
            break;
    }
}

// --- Sync Timer Logic --- (No changes needed)
function startSyncTimer() {
    stopSyncTimer();
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
        return;
    }

    try {
        const state1 = player1.getPlayerState();
        const state2 = player2.getPlayerState();

        if (state1 === YT.PlayerState.PLAYING && state2 === YT.PlayerState.PLAYING) {
            const time1 = player1.getCurrentTime();
            const time2 = player2.getCurrentTime();
            const diff = Math.abs(time1 - time2);

            if (diff > SYNC_THRESHOLD_DRIFT) {
                // console.log(`Drift Check: P1=${time1.toFixed(2)}, P2=${time2.toFixed(2)}. Diff=${diff.toFixed(2)} > ${SYNC_THRESHOLD_DRIFT}. Syncing P2->P1.`);
                setSyncing(true); // LOCK
                player2.seekTo(time1, true);
                clearSyncingTimeout(150); // UNLOCK after short delay
            }
        }
    } catch (e) {
        console.warn("Error during sync check:", e);
        stopSyncTimer();
    }
}

// --- Helper functions for isSyncing flag --- (No changes needed)
function setSyncing(status) {
    // console.log(`Setting isSyncing to: ${status}`);
    isSyncing = status;
    if (status && syncTimeout) {
         clearTimeout(syncTimeout);
         syncTimeout = null;
    }
}

function clearSyncingTimeout(delay = 250) {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        // console.log("Resetting isSyncing via timeout");
        isSyncing = false;
        syncTimeout = null;
    }, delay);
}

// Initial setup
loadBtn.disabled = true; // Still disable initially until API is ready