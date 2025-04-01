// Global variables for player instances
let player1 = null;
let player2 = null;
let playersReady = 0; // Counter for ready players
let isSyncing = false; // Flag to prevent event loops
const statusElement = document.getElementById('status');
const loadBtn = document.getElementById('loadVideosBtn');
const videoId1Input = document.getElementById('videoId1');
const videoId2Input = document.getElementById('videoId2');

let syncInterval = null; // Variable to hold the interval timer
const SYNC_THRESHOLD = 1.0; // Max allowed time difference in seconds before resync
const SYNC_INTERVAL_MS = 1500; // How often to check for drift (milliseconds)

// 1. API Ready Callback
window.onYouTubeIframeAPIReady = function() {
    statusElement.textContent = 'API Loaded. Enter Video IDs and click "Load Videos".';
    loadBtn.disabled = false;
    loadBtn.onclick = loadVideos;
};

// 2. Load Videos Function
function loadVideos() {
    const videoId1 = videoId1Input.value.trim();
    const videoId2 = videoId2Input.value.trim();

    if (!videoId1 || !videoId2) {
        statusElement.textContent = 'Please enter valid YouTube Video IDs for both players.';
        return;
    }

    statusElement.textContent = 'Loading videos...';
    loadBtn.disabled = true; // Disable button during load

    // Reset state and clear previous interval
    playersReady = 0;
    stopSyncTimer();
    destroyPlayers();

    // Create Player 1
    player1 = new YT.Player('player1', {
        height: '360',
        width: '640',
        videoId: videoId1,
        playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });

    // Create Player 2
    player2 = new YT.Player('player2', {
        height: '360',
        width: '640',
        videoId: videoId2,
        playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });
}

// 3. Destroy Players Function
function destroyPlayers() {
    stopSyncTimer(); // Make sure timer is stopped
    if (player1 && typeof player1.destroy === 'function') {
        player1.destroy();
        player1 = null;
    }
    if (player2 && typeof player2.destroy === 'function') {
        player2.destroy();
        player2 = null;
    }
    document.getElementById('player1').innerHTML = '';
    document.getElementById('player2').innerHTML = '';
}

// 4. Player Ready Handler
function onPlayerReady(event) {
    playersReady++;
    if (playersReady === 2) {
        statusElement.textContent = 'Players Ready. Controls are synced.';
        loadBtn.disabled = false;
        startSyncTimer(); // Start checking for drift
    } else {
         statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
    }
}

// 5. Player State Change Handler
function onPlayerStateChange(event) {
    if (isSyncing || playersReady < 2) {
        // If we triggered this change or players aren't ready, ignore it
        // Reset flag if needed, although it should be reset after the sync action
        // isSyncing = false; // Might reset too early if action is async
        return;
    }

    const state = event.data;
    const sourcePlayer = event.target;
    const targetPlayer = (sourcePlayer === player1) ? player2 : player1;

    // console.log("State Change:", state, "Source:", (sourcePlayer === player1) ? "P1" : "P2");

    setSyncing(true); // Set flag BEFORE potentially triggering actions

    switch (state) {
        case YT.PlayerState.PLAYING:
            // Only command the target to play. Time sync handled by pause/seek and drift check.
            targetPlayer.playVideo();
            // Start the sync timer if it wasn't running (e.g., after buffering/pause)
            startSyncTimer();
            // console.log("Sync: Play Command");
            clearSyncingTimeout(); // Clear previous timeouts if any
            break;

        case YT.PlayerState.PAUSED:
            // Pause the target AND explicitly sync time here, as pausing is a deliberate sync point.
            targetPlayer.pauseVideo();
             // Get time AFTER telling the other to pause
            const pausedTime = sourcePlayer.getCurrentTime();
             // Use a slight delay seeking after pausing allows the pause command to process
            setTimeout(() => {
                 targetPlayer.seekTo(pausedTime, true);
                 // console.log("Sync: Pause & Seek", "Time:", pausedTime);
                 // Stop the sync timer when paused to avoid unnecessary checks
                 stopSyncTimer();
                 clearSyncingTimeout(); // Safe to clear the flag now
            }, 150); // Increased delay slightly
             // IMPORTANT: Don't reset isSyncing immediately here due to the timeout
            return; // Prevent immediate reset of isSyncing flag below

        case YT.PlayerState.BUFFERING:
            // Optional: Pause the other player cleanly? Often unnecessary.
            // targetPlayer.pauseVideo();
            // console.log("Sync: Buffering detected");
            // Stop sync timer during buffer to prevent potentially bad syncs
            stopSyncTimer();
            break;

        case YT.PlayerState.ENDED:
            // Optional: Pause the other player cleanly
            targetPlayer.pauseVideo();
            // console.log("Sync: Ended");
            stopSyncTimer(); // Stop timer when ended
            break;

        // case YT.PlayerState.CUED:
            // console.log("Sync: Cued");
            // break;
    }

    // Reset the flag after a short delay ONLY IF not handled by PAUSED state's timeout
     if (state !== YT.PlayerState.PAUSED) {
       clearSyncingTimeout();
    }
}

// --- Sync Timer Logic ---

function startSyncTimer() {
    // Clear any existing timer before starting a new one
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
        return; // Don't sync if already syncing, players not ready, or players destroyed
    }

    const state1 = player1.getPlayerState();
    const state2 = player2.getPlayerState();

    // Only sync if BOTH players are supposed to be playing
    if (state1 === YT.PlayerState.PLAYING && state2 === YT.PlayerState.PLAYING) {
        const time1 = player1.getCurrentTime();
        const time2 = player2.getCurrentTime();
        const diff = Math.abs(time1 - time2);

        if (diff > SYNC_THRESHOLD) {
            // console.log(`Drift detected: P1=${time1.toFixed(2)}s, P2=${time2.toFixed(2)}s. Diff=${diff.toFixed(2)}s. Syncing.`);
            setSyncing(true); // Prevent state change loop from seek

            // Sync Player 2 to Player 1's time
            player2.seekTo(time1, true);

            // Reset the syncing flag after a short delay to allow seek to process
            clearSyncingTimeout();
        }
    }
    // If one is playing and the other isn't (and not buffering/cued), maybe force play?
    // else if (state1 === YT.PlayerState.PLAYING && (state2 === YT.PlayerState.PAUSED || state2 === YT.PlayerState.ENDED)) {
    //      console.log("Sync Check: P1 playing, P2 not. Forcing P2 play.");
    //      setSyncing(true);
    //      player2.playVideo();
    //      clearSyncingTimeout();
    // } // Add similar check for P2 playing / P1 not

}

// --- Helper functions for isSyncing flag ---
// Use these to manage the flag with a safety timeout reset

let syncTimeout = null;

function setSyncing(status) {
    // console.log("Setting isSyncing to:", status);
    isSyncing = status;
    // Clear any previous timeout just in case
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
}

function clearSyncingTimeout() {
    // Clear the flag after a short delay (e.g., 250ms)
    // This prevents race conditions where the stateChange event fires slightly
    // before our sync action fully completes or if the action doesn't fire an event.
    if (syncTimeout) clearTimeout(syncTimeout); // Clear previous one if exists
    syncTimeout = setTimeout(() => {
        // console.log("Resetting isSyncing via timeout");
        isSyncing = false;
        syncTimeout = null;
    }, 250); // Adjust delay if needed
}


// Initial setup: Disable button until API is ready
loadBtn.disabled = true;