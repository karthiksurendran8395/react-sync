// --- Global Variables & DOM References ---
// Ensure elements exist before assigning potentially null values
const statusElement = document.getElementById('status');
const loadBtn = document.getElementById('loadVideosBtn');
const videoId1Input = document.getElementById('videoId1');
const videoId2Input = document.getElementById('videoId2');
const toggleViewBtn = document.getElementById('toggleViewBtn');
const mainContainer = document.querySelector('.main-container');

// Player instances
let player1 = null;
let player2 = null;
let playersReady = 0; // Counter for ready players
let isSyncing = false; // Flag to prevent event loops/re-entrancy

// --- Sync State Variables ---
let syncInterval = null; // Interval timer for periodic drift checks
const SYNC_THRESHOLD_DRIFT = 1.0; // Max allowed time difference (seconds) for background drift correction
const SYNC_THRESHOLD_SEEK = 0.5; // Max allowed time diff (seconds) in PLAYING handler before forcing a seek
const SYNC_INTERVAL_MS = 1500; // How often (ms) to check for drift
let syncTimeout = null; // Timeout handle for resetting the isSyncing flag


// --- Helper function to extract Video ID ---
function extractVideoId(input) {
    if (!input) return null;
    input = input.trim();
    // Regex covers: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID
    // Also handles parameters like ?t= or ?si=
    const urlRegex = /(?:watch\?v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/;
    const match = input.match(urlRegex);
    if (match && match[1]) { return match[1]; }
    // Check if input itself is a valid ID format
    const plainIdRegex = /^[a-zA-Z0-9_-]{11}$/;
    if (plainIdRegex.test(input)) { return input; }
    console.warn(`Could not extract valid video ID from input: "${input}"`);
    return null;
}

// --- YouTube IFrame API Setup ---
// This function is called automatically by the YouTube API script
window.onYouTubeIframeAPIReady = function() {
    console.log("YouTube IFrame API Ready");
    if (statusElement) statusElement.textContent = 'API Loaded. Enter Video URLs/IDs and click "Load Videos".';
    // Enable the load button ONLY if it exists
    if (loadBtn) {
        loadBtn.disabled = false;
        console.log("Load Videos button enabled.");
    } else {
        console.error("Load button not found when API ready!");
    }
};

// --- Core Player Logic ---

// Load Videos Function
function loadVideos() {
    console.log("loadVideos function called.");
    if (!videoId1Input || !videoId2Input || !statusElement || !loadBtn) {
        console.error("Required elements missing for loadVideos.");
        if (statusElement) statusElement.textContent = "Error: UI elements missing.";
        return;
    }

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
        console.log("Video ID validation failed:", errorMessages);
        return; // Stop if IDs are invalid
    }

    console.log("Loading videos with IDs:", videoId1, videoId2);
    statusElement.textContent = 'Loading videos...';
    loadBtn.disabled = true; // Disable load button while loading

    // --- Reset State ---
    playersReady = 0;
    isSyncing = false;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    stopSyncTimer();
    destroyPlayers(); // Destroy previous players before creating new ones

    // --- Create New Players ---
    try {
        console.log("Creating Player 1");
        player1 = new YT.Player('player1', {
            height: '360', width: '640', videoId: videoId1,
            playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });

        console.log("Creating Player 2");
        player2 = new YT.Player('player2', {
            height: '360', width: '640', videoId: videoId2,
            playerVars: { 'playsinline': 1, 'enablejsapi': 1 },
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });
    } catch (error) {
        console.error("Error creating YouTube players:", error);
        if (statusElement) statusElement.textContent = "Error loading players. Check console.";
        // Keep loadBtn disabled if player creation failed
    }
}

// Destroy Players Function
function destroyPlayers() {
    console.log("Destroying existing players...");
    stopSyncTimer();
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    isSyncing = false;

    // Destroy Player 1
    if (player1 && typeof player1.destroy === 'function') {
        try { player1.destroy(); console.log("Player 1 destroyed."); }
        catch (e) { console.warn("Error destroying player1:", e); }
        player1 = null;
    }
    // Destroy Player 2
    if (player2 && typeof player2.destroy === 'function') {
        try { player2.destroy(); console.log("Player 2 destroyed."); }
        catch (e) { console.warn("Error destroying player2:", e); }
        player2 = null;
    }

    // Ensure placeholders are cleared visually
    const p1Element = document.getElementById('player1');
    const p2Element = document.getElementById('player2');
    if (p1Element) p1Element.innerHTML = '';
    if (p2Element) p2Element.innerHTML = '';
}

// Player Ready Handler
function onPlayerReady(event) {
    playersReady++;
    const playerName = event.target === player1 ? "Player 1" : "Player 2";
    console.log(`${playerName} is Ready. Total ready: ${playersReady}`);

    if (playersReady === 2) {
        if (statusElement) statusElement.textContent = 'Players Ready. Controls are synced.';
        // Re-enable load button only when BOTH players are fully ready
        if (loadBtn) {
            loadBtn.disabled = false;
            console.log("Load button re-enabled (both players ready).");
        }
    } else if (playersReady < 2) {
        if (statusElement) statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
    }
}

// Player State Change Handler
function onPlayerStateChange(event) {
    // Ignore events if not fully ready, or if currently syncing
    if (isSyncing || playersReady < 2 || !player1 || !player2) {
        // console.log("State change ignored (syncing/not ready/players missing)");
        return;
    }

    const sourcePlayer = event.target;
    const targetPlayer = (sourcePlayer === player1) ? player2 : player1;
    const sourceName = (sourcePlayer === player1) ? "P1" : "P2";

    // Ensure target player still exists and is valid
    if (!targetPlayer || typeof targetPlayer.getPlayerState !== 'function') {
        console.warn(`Target player for ${sourceName} state change not available.`);
        return;
    }

    let newState = -99; // Default invalid state
    let sourceTime = 0;

    try {
        newState = event.data; // Get the new state code (e.g., 1 for PLAYING)
        sourceTime = sourcePlayer.getCurrentTime(); // Get current time of the player that changed state
        console.log(`State Change: ${sourceName} -> ${getPlayerStateName(newState)} @ ${sourceTime.toFixed(2)}s`);
    } catch(e) {
        console.warn(`Error getting state (${event.data}) or time from ${sourceName}:`, e);
        return; // Don't sync if we can't get reliable info
    }

    setSyncing(true); // ----- LOCK -----
    syncTargetPlayer(targetPlayer, sourcePlayer, newState, sourceTime);
    clearSyncingTimeout(250); // ----- UNLOCK after delay -----
}

// Helper to get state name (for logging)
function getPlayerStateName(stateCode) {
    for (const state in YT.PlayerState) {
        if (YT.PlayerState[state] === stateCode) {
            return state;
        }
    }
    return `UNKNOWN (${stateCode})`;
}


// Core Synchronization Logic
function syncTargetPlayer(targetPlayer, sourcePlayer, sourceState, sourceTime) {
    // Double check players exist (might have been destroyed between event and execution)
    if (!targetPlayer || typeof targetPlayer.getPlayerState !== 'function' || !sourcePlayer) {
         console.warn("Sync aborted: Target or source player invalid in syncTargetPlayer.");
         return;
    }

    let targetState = -99;
    try {
        targetState = targetPlayer.getPlayerState();
    } catch(e) {
        console.warn("Sync aborted: Error getting target player state:", e);
        return; // Cannot sync if target state is unknown
    }

    const targetName = targetPlayer === player1 ? "P1" : "P2";
    // console.log(`SYNC ACTION for ${targetName}: Source State=${getPlayerStateName(sourceState)}, Target State=${getPlayerStateName(targetState)}`);

    try { // Wrap API calls in try-catch for safety
        switch (sourceState) {
            case YT.PlayerState.PLAYING: // 1
                let targetTime = 0;
                try { targetTime = targetPlayer.getCurrentTime(); }
                catch (e) { console.warn("Couldn't get target time, will seek/play anyway."); }

                const timeDiff = Math.abs(sourceTime - targetTime);
                // console.log(` - PLAYING: Time diff = ${timeDiff.toFixed(2)}`);

                // Seek only if difference is significant (user likely seeked source)
                if (timeDiff > SYNC_THRESHOLD_SEEK) {
                    // console.log(` - PLAYING: Seeking ${targetName} to ${sourceTime.toFixed(2)}`);
                    targetPlayer.seekTo(sourceTime, true);
                }
                // Ensure target is playing if source is playing
                if (targetState !== YT.PlayerState.PLAYING && targetState !== YT.PlayerState.BUFFERING) {
                    // console.log(` - PLAYING: Calling playVideo() on ${targetName}`);
                    targetPlayer.playVideo();
                }
                startSyncTimer(); // Ensure drift check timer runs
                break;

            case YT.PlayerState.PAUSED: // 2
                stopSyncTimer(); // Stop drift check when paused
                // Pause the target player if it's not already paused
                if (targetState !== YT.PlayerState.PAUSED) {
                    // console.log(` - PAUSED: Calling pauseVideo() on ${targetName}`);
                    targetPlayer.pauseVideo();
                }
                // Seek slightly *after* the pause command for robustness
                // This helps ensure the player is in a state where seekTo is reliable
                setTimeout(() => {
                    // Check again if players are still valid and ready before seeking
                    if (playersReady === 2 && targetPlayer && typeof targetPlayer.seekTo === 'function') {
                        try {
                            // Final check: Is target *actually* paused now?
                            if(targetPlayer.getPlayerState() === YT.PlayerState.PAUSED){
                                targetPlayer.seekTo(sourceTime, true);
                                // console.log(` - PAUSED: Seek ${targetName} to ${sourceTime.toFixed(2)} (delayed)`);
                            } else {
                                // console.log(` - PAUSED: Skipped delayed seek as ${targetName} was not paused.`);
                            }
                        } catch (e) { console.warn(`Error seeking ${targetName} in pause timeout:`, e); }
                    }
                }, 150); // Slightly longer delay might be safer
                break;

            case YT.PlayerState.BUFFERING: // 3
                stopSyncTimer(); // Buffering implies not playing steadily
                // If target is playing, pause it to wait for source
                if (targetState === YT.PlayerState.PLAYING) {
                    // console.log(` - BUFFERING: Pausing ${targetName} while source buffers`);
                    targetPlayer.pauseVideo();
                    // Optional: seek target to match source time during buffer pause?
                    // try { targetPlayer.seekTo(sourceTime, true); } catch(e){}
                }
                break;

            case YT.PlayerState.ENDED: // 0
                // console.log(` - ENDED: Pausing ${targetName} at ${sourceTime.toFixed(2)}`);
                stopSyncTimer();
                 // Ensure target is paused
                 if (targetState !== YT.PlayerState.PAUSED && targetState !== YT.PlayerState.ENDED) {
                     targetPlayer.pauseVideo();
                 }
                // Seek target to the end time (sourceTime should be video duration or close)
                try { targetPlayer.seekTo(sourceTime, true); }
                catch(e) { console.warn(`Error seeking ${targetName} on ENDED state:`, e); }
                break;

             case YT.PlayerState.CUED: // 5
                 // Usually happens after loading. Might pause the other player if it started playing?
                 stopSyncTimer();
                  if (targetState === YT.PlayerState.PLAYING) {
                     // console.log(` - CUED: Source cued, pausing ${targetName}`);
                     targetPlayer.pauseVideo();
                 }
                 // Seek target to beginning? Generally handled by onReady/initial load.
                 // try { targetPlayer.seekTo(0, true); } catch(e){}
                 break;

            // case YT.PlayerState.UNSTARTED: // -1
            //     // Usually no action needed here, handled by load.
            //     break;
        }
    } catch (error) {
        console.error(`Error during syncTargetPlayer action for ${targetName} (source state ${sourceState}):`, error);
        // Consider stopping timer or other recovery if errors persist
        stopSyncTimer();
    }
}

// --- Sync Timer Logic (Drift Check) ---
function startSyncTimer() {
    // Don't start if already running
    if (syncInterval) return;
    stopSyncTimer(); // Clear just in case
    // console.log("Starting sync timer (drift check)");
    syncInterval = setInterval(checkAndSyncTime, SYNC_INTERVAL_MS);
}

function stopSyncTimer() {
    if (syncInterval) {
        // console.log("Stopping sync timer (drift check)");
        clearInterval(syncInterval);
        syncInterval = null;
    }
}

function checkAndSyncTime() {
    // Only run if not syncing, both players ready and valid
     if (isSyncing || playersReady < 2 || !player1 || !player2 ||
         typeof player1.getPlayerState !== 'function' || typeof player2.getPlayerState !== 'function') {
        return;
    }

    try {
        const state1 = player1.getPlayerState();
        const state2 = player2.getPlayerState();

        // Only perform drift correction if BOTH players are actively PLAYING.
        if (state1 === YT.PlayerState.PLAYING && state2 === YT.PlayerState.PLAYING) {
            const time1 = player1.getCurrentTime();
            const time2 = player2.getCurrentTime();
            const diff = Math.abs(time1 - time2);

            // If drift exceeds threshold, sync Player 2 to Player 1
            if (diff > SYNC_THRESHOLD_DRIFT) {
                console.log(`Drift Check: P1=${time1.toFixed(2)}, P2=${time2.toFixed(2)}. Diff=${diff.toFixed(2)} > ${SYNC_THRESHOLD_DRIFT}. Syncing P2->P1.`);
                setSyncing(true); // ----- LOCK -----
                player2.seekTo(time1, true);
                clearSyncingTimeout(150); // ----- UNLOCK after short delay -----
            }
        } else {
            // If players are not both playing, the drift check timer isn't needed.
            // console.log("Drift Check: Players not both playing, stopping timer.");
             stopSyncTimer();
        }
    } catch (e) {
        console.warn("Error during sync check (drift):", e);
        stopSyncTimer(); // Stop timer if players error out
    }
}

// --- Helper functions for isSyncing flag ---
function setSyncing(status) {
    // const from = isSyncing; // For debugging complex issues
    isSyncing = status;
    // console.log(`isSyncing: ${from} -> ${status}`);
    // If we are starting to sync (true), clear any pending unlock timeout immediately
    if (status && syncTimeout) {
         clearTimeout(syncTimeout);
         syncTimeout = null;
    }
}

function clearSyncingTimeout(delay = 250) {
    // Clear any previous unlock timeout first
    if (syncTimeout) clearTimeout(syncTimeout);
    // Set a new timeout to unlock (set isSyncing back to false)
    syncTimeout = setTimeout(() => {
        // console.log("Resetting isSyncing via timeout");
        isSyncing = false;
        syncTimeout = null; // Clear the handle reference
    }, delay);
}

// --- UI Interaction Logic ---

function setupButtonListeners() {
    // Setup Load Button Listener
    if (loadBtn) {
        loadBtn.onclick = loadVideos;
        console.log("Load Videos button listener attached.");
    } else {
        console.error("Load Videos button not found during listener setup!");
    }

    // Setup Toggle Button Listener
    if (toggleViewBtn && mainContainer) {
        toggleViewBtn.onclick = () => {
            console.log("Toggle view button clicked.");
            // Toggle classes on both container and body
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

                // Optional: Force a reflow/resize which might help layout when exiting fullscreen
                // It shouldn't be strictly necessary with the CSS transitions.
                 // window.dispatchEvent(new Event('resize'));
            }
             console.log("Fullscreen active:", document.body.classList.contains('fullscreen-active'));
        };
        console.log("Toggle view button listener attached.");

    } else {
        console.warn("Toggle view button or main container not found during listener setup.");
    }
}


// --- Initial Setup ---
// Use DOMContentLoaded to ensure HTML elements are available
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded.");

    // Initial button state (disabled until API ready)
    if (loadBtn) {
        loadBtn.disabled = true;
        console.log("Load button initially disabled.");
    } else {
         console.error("Load button not found on DOMContentLoaded!");
    }

    // Ensure initial view state is correct
     if (mainContainer) mainContainer.classList.remove('controls-hidden');
     document.body.classList.remove('fullscreen-active');
     if (toggleViewBtn) toggleViewBtn.setAttribute('aria-pressed', 'false');


    // Set up button listeners now that the DOM is ready
    setupButtonListeners();
});

console.log("Script execution finished."); // Log end of script load