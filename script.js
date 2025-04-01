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
    loadBtn.disabled = true;

    // Reset state fully
    playersReady = 0;
    isSyncing = false;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    stopSyncTimer();
    destroyPlayers();

    // Create Player 1
    player1 = new YT.Player('player1', {
        height: '360', width: '640', videoId: videoId1,
        playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });

    // Create Player 2
    player2 = new YT.Player('player2', {
        height: '360', width: '640', videoId: videoId2,
        playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

// 3. Destroy Players Function
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
    document.getElementById('player1').innerHTML = '';
    document.getElementById('player2').innerHTML = '';
}

// 4. Player Ready Handler
function onPlayerReady(event) {
    playersReady++;
    if (playersReady === 2) {
        statusElement.textContent = 'Players Ready. Controls are synced.';
        loadBtn.disabled = false;
    } else {
         statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
    }
}

// 5. Player State Change Handler (Remains Simple)
function onPlayerStateChange(event) {
    if (isSyncing || playersReady < 2) {
        return;
    }

    const sourcePlayer = event.target;
    const targetPlayer = (sourcePlayer === player1) ? player2 : player1;
    const newState = event.data;
    const sourceTime = sourcePlayer.getCurrentTime();

    // const sourceName = (sourcePlayer === player1) ? "P1" : "P2";
    // console.log(`State Change Event: ${sourceName} -> ${newState} @ ${sourceTime.toFixed(2)}s`);

    setSyncing(true); // LOCK

    syncTargetPlayer(targetPlayer, sourcePlayer, newState, sourceTime);

    clearSyncingTimeout(250); // UNLOCK after delay
}

// 6. Core Synchronization Logic (Modified PLAYING case)
function syncTargetPlayer(targetPlayer, sourcePlayer, sourceState, sourceTime) {
    if (!targetPlayer || !sourcePlayer) return; // Safety check

    const targetState = targetPlayer.getPlayerState();

    // console.log(`SYNC FUNCTION: Target=${targetPlayer === player1 ? 'P1' : 'P2'}, SourceState=${sourceState}, SourceTime=${sourceTime.toFixed(2)}`);

    switch (sourceState) {
        case YT.PlayerState.PLAYING:
            // ACTION: Make target play. Only seek if times are significantly different.
            let targetTime = 0;
            try { // Add try-catch as getCurrentTime can fail if player is not ready/destroyed
                targetTime = targetPlayer.getCurrentTime();
            } catch (e) {
                console.warn("Error getting target time:", e);
                // If we can't get target time, maybe best to seek? Or just play? Let's try seeking.
                targetPlayer.seekTo(sourceTime, true);
                targetPlayer.playVideo();
                startSyncTimer();
                return; // Exit early if error getting time
            }

            const timeDiff = Math.abs(sourceTime - targetTime);

            // console.log(`SYNC - PLAYING: SourceTime=${sourceTime.toFixed(2)}, TargetTime=${targetTime.toFixed(2)}, Diff=${timeDiff.toFixed(2)}`);

            // Only seek if the time difference is larger than our threshold (e.g., user seeked)
            if (timeDiff > SYNC_THRESHOLD_SEEK) {
                 // console.log(`SYNC - PLAYING: Seeking target, diff ${timeDiff.toFixed(2)} > ${SYNC_THRESHOLD_SEEK}`);
                targetPlayer.seekTo(sourceTime, true);
            } else {
                // Time difference is small, likely resume/buffer recovery. Don't seek.
                // console.log(`SYNC - PLAYING: Skipping seek, diff ${timeDiff.toFixed(2)} <= ${SYNC_THRESHOLD_SEEK}`);
            }

            // Ensure the target player is playing if the source is playing.
            // Avoid calling playVideo if it's already playing to be slightly more efficient.
             if (targetState !== YT.PlayerState.PLAYING) {
                 // console.log(`SYNC - PLAYING: Calling playVideo() on target (State was ${targetState})`);
                targetPlayer.playVideo();
             } else {
                 // console.log(`SYNC - PLAYING: Target already playing, skipping playVideo().`);
             }

            startSyncTimer(); // Ensure drift check runs while playing
            break;

        case YT.PlayerState.PAUSED:
            // ACTION: Make target pause at the source's current time. (Same as v5)
            stopSyncTimer();
            targetPlayer.pauseVideo();
            // Use timeout for seek after pause for robustness
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
            // ACTION: Pause target while source is buffering. (Same as v5)
            stopSyncTimer();
            if (targetState !== YT.PlayerState.PAUSED && targetState !== YT.PlayerState.BUFFERING) {
                // console.log("Sync Action: Buffering detected on Source, pausing Target");
                targetPlayer.pauseVideo();
                // Optional: targetPlayer.seekTo(sourceTime, true);
            }
            break;

        case YT.PlayerState.ENDED:
            // ACTION: Pause target when source ends. (Same as v5)
             // console.log("Sync Action: Source Ended, pausing Target");
            stopSyncTimer();
            if (targetState !== YT.PlayerState.PAUSED) {
                 targetPlayer.pauseVideo();
            }
            targetPlayer.seekTo(sourceTime, true); // Seek to end time
            break;

        // Other states (UNSTARTED, CUED) usually don't require explicit sync actions.
    }
}

// --- Sync Timer Logic --- (Checks for drift during playback)
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

    try { // Add try-catch as getPlayerState can fail if player not ready/destroyed
        const state1 = player1.getPlayerState();
        const state2 = player2.getPlayerState();

        // Only perform drift correction if BOTH players are PLAYING.
        if (state1 === YT.PlayerState.PLAYING && state2 === YT.PlayerState.PLAYING) {
            const time1 = player1.getCurrentTime();
            const time2 = player2.getCurrentTime();
            const diff = Math.abs(time1 - time2);

            // Use the DRIFT threshold here
            if (diff > SYNC_THRESHOLD_DRIFT) {
                // console.log(`Drift Check: P1=${time1.toFixed(2)}, P2=${time2.toFixed(2)}. Diff=${diff.toFixed(2)} > ${SYNC_THRESHOLD_DRIFT}. Syncing P2->P1.`);
                setSyncing(true); // LOCK

                // Correct the time of Player 2 to match Player 1.
                player2.seekTo(time1, true);

                clearSyncingTimeout(150); // UNLOCK after short delay
            }
        }
    } catch (e) {
        console.warn("Error during sync check:", e);
        stopSyncTimer(); // Stop timer if players error out
    }
}

// --- Helper functions for isSyncing flag --- (Manages the sync lock)
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
loadBtn.disabled = true;