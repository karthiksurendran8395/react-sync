// --- Global Variables & DOM References ---
// Use const for elements that shouldn't be reassigned
const statusElement = document.getElementById('status');
const loadBtn = document.getElementById('loadVideosBtn');
const videoId1Input = document.getElementById('videoId1');
const videoId2Input = document.getElementById('videoId2');
const toggleViewBtn = document.getElementById('toggleViewBtn');
const mainContainer = document.querySelector('.main-container');
const syncToggleCheckbox = document.getElementById('syncToggleCheckbox');

// Player instances - use let as they are reassigned
let player1 = null;
let player2 = null;
let playersReady = 0;
let isSyncing = false; // Internal flag to prevent event loops

// --- Sync State Variables ---
let isSyncGloballyEnabled = true; // Master switch for sync controls, default ON
let syncOffsetSeconds = 0; // Stores the time difference (P2 time - P1 time)
let syncInterval = null;
const SYNC_THRESHOLD_DRIFT = 1.0;
const SYNC_THRESHOLD_SEEK = 0.5;
const SYNC_INTERVAL_MS = 1500;
let syncTimeout = null;


// --- Helper function to extract Video ID ---
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

// Load Videos Function
function loadVideos() {
    console.log("loadVideos function called.");
    // Check required elements exist
    if (!videoId1Input || !videoId2Input || !statusElement || !loadBtn || !syncToggleCheckbox) {
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
        return;
    }

    console.log("Loading videos with IDs:", videoId1, videoId2);
    statusElement.textContent = 'Loading videos...';
    loadBtn.disabled = true;

    // --- Reset State ---
    playersReady = 0;
    isSyncing = false;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    stopSyncTimer();
    destroyPlayers();
    isSyncGloballyEnabled = true;
    syncOffsetSeconds = 0; // Reset offset on load
    syncToggleCheckbox.checked = true;
    console.log("State reset for load: Global Sync ON, Offset 0s");

    // --- Create New Players ---
    try {
        console.log("Creating Player 1");
        player1 = new YT.Player('player1', { height: '360', width: '640', videoId: videoId1, playerVars: { 'playsinline': 1, 'enablejsapi': 1 }, events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange } });
        console.log("Creating Player 2");
        player2 = new YT.Player('player2', { height: '360', width: '640', videoId: videoId2, playerVars: { 'playsinline': 1, 'enablejsapi': 1 }, events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange } });
    } catch (error) {
        console.error("Error creating YouTube players:", error);
        if (statusElement) statusElement.textContent = "Error loading players. Check console.";
    }
}

// Destroy Players Function
function destroyPlayers() {
    console.log("Destroying existing players...");
    stopSyncTimer();
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;
    isSyncing = false;

    if (player1 && typeof player1.destroy === 'function') { try { player1.destroy(); console.log("Player 1 destroyed."); } catch (e) { console.warn("Error destroying player1:", e); } player1 = null; }
    if (player2 && typeof player2.destroy === 'function') { try { player2.destroy(); console.log("Player 2 destroyed."); } catch (e) { console.warn("Error destroying player2:", e); } player2 = null; }

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
        if (statusElement) statusElement.textContent = 'Players Ready.'; // Initial message
        updateSyncStatusMessage(); // Update based on checkbox state & offset
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
    if (!isSyncGloballyEnabled) {
        const newState = event.data;
        if (newState === YT.PlayerState.PAUSED || newState === YT.PlayerState.ENDED || newState === YT.PlayerState.BUFFERING) {
             stopSyncTimer();
        }
        return; // >>> EXIT if global sync is off
    }
    if (isSyncing || playersReady < 2 || !player1 || !player2) { return; }

    const sourcePlayer = event.target;
    const targetPlayer = (sourcePlayer === player1) ? player2 : player1;
    if (!targetPlayer || typeof targetPlayer.getPlayerState !== 'function') {
        console.warn("Target player not available during state change."); return;
    }

    let newState = -99, sourceTime = 0;
    try {
        newState = event.data;
        sourceTime = sourcePlayer.getCurrentTime();
        console.log(`State Change (Sync ON): ${getPlayerStateName(newState)} @ ${sourceTime.toFixed(2)}s`);
    } catch(e) {
        console.warn(`Error getting state (${event.data}) or time:`, e); return;
    }

    setSyncing(true); // ----- LOCK -----
    // Pass the current offset to the sync function
    syncTargetPlayer(targetPlayer, sourcePlayer, newState, sourceTime, syncOffsetSeconds);
    clearSyncingTimeout(250); // ----- UNLOCK after delay -----
}

// Helper to get state name
function getPlayerStateName(stateCode) {
    for (const state in YT.PlayerState) { if (YT.PlayerState[state] === stateCode) { return state; } }
    return `UNKNOWN (${stateCode})`;
}

// Core Synchronization Logic (Handles Offset)
function syncTargetPlayer(targetPlayer, sourcePlayer, sourceState, sourceTime, offset) {
    if (!targetPlayer || typeof targetPlayer.getPlayerState !== 'function' || !sourcePlayer) { return; }
    let targetState = -99;
    try { targetState = targetPlayer.getPlayerState(); }
    catch(e) { console.warn("Sync aborted: Error getting target player state:", e); return; }
    const targetName = targetPlayer === player1 ? "P1" : "P2";
    let targetSeekTime; // Calculated target time based on offset

    try {
        switch (sourceState) {
            case YT.PlayerState.PLAYING: // 1
                let currentTargetTime = 0; try { currentTargetTime = targetPlayer.getCurrentTime(); } catch (e) {}
                if (sourcePlayer === player1) { targetSeekTime = sourceTime + offset; }
                else { targetSeekTime = sourceTime - offset; }
                const timeDiffPlaying = Math.abs(currentTargetTime - targetSeekTime);

                if (timeDiffPlaying > SYNC_THRESHOLD_SEEK) {
                    targetPlayer.seekTo(targetSeekTime, true);
                }
                if (targetState !== YT.PlayerState.PLAYING && targetState !== YT.PlayerState.BUFFERING) {
                    targetPlayer.playVideo();
                }
                startSyncTimer();
                break;

            case YT.PlayerState.PAUSED: // 2
                stopSyncTimer();
                if (targetState !== YT.PlayerState.PAUSED) {
                    targetPlayer.pauseVideo();
                }
                if (sourcePlayer === player1) { targetSeekTime = sourceTime + offset; }
                else { targetSeekTime = sourceTime - offset; }

                setTimeout(() => {
                    if (playersReady === 2 && targetPlayer && typeof targetPlayer.seekTo === 'function') {
                        try { if(targetPlayer.getPlayerState() === YT.PlayerState.PAUSED){ targetPlayer.seekTo(targetSeekTime, true); } }
                        catch (e) { console.warn(`Error seeking ${targetName} in pause timeout:`, e); }
                    }
                }, 150);
                break;

            case YT.PlayerState.BUFFERING: // 3
                stopSyncTimer();
                if (targetState === YT.PlayerState.PLAYING) { targetPlayer.pauseVideo(); }
                break;

            case YT.PlayerState.ENDED: // 0
                stopSyncTimer();
                 if (targetState !== YT.PlayerState.PAUSED && targetState !== YT.PlayerState.ENDED) { targetPlayer.pauseVideo(); }
                if (sourcePlayer === player1) { targetSeekTime = sourceTime + offset; }
                else { targetSeekTime = sourceTime - offset; }
                try { targetPlayer.seekTo(targetSeekTime, true); }
                catch(e) { console.warn(`Error seeking ${targetName} on ENDED state:`, e); }
                break;

             case YT.PlayerState.CUED: // 5
                 stopSyncTimer();
                  if (targetState === YT.PlayerState.PLAYING) { targetPlayer.pauseVideo(); }
                 break;
        }
    } catch (error) {
        console.error(`Error during syncTargetPlayer action for ${targetName} (source state ${sourceState}):`, error);
        stopSyncTimer();
    }
}

// --- Sync Timer Logic (Drift Check - Handles Offset) ---
function startSyncTimer() {
    if (!isSyncGloballyEnabled || syncInterval) { return; } // Don't start if disabled or running
    stopSyncTimer();
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
    if (!isSyncGloballyEnabled) { stopSyncTimer(); return; } // Stop if disabled
    if (isSyncing || playersReady < 2 || !player1 || !player2 ||
         typeof player1.getPlayerState !== 'function' || typeof player2.getPlayerState !== 'function') {
        return;
    }

    try {
        const state1 = player1.getPlayerState();
        const state2 = player2.getPlayerState();
        if (state1 === YT.PlayerState.PLAYING && state2 === YT.PlayerState.PLAYING) {
            const time1 = player1.getCurrentTime();
            const time2 = player2.getCurrentTime();
            const expectedTime2 = time1 + syncOffsetSeconds; // Expected P2 time
            const diff = Math.abs(time2 - expectedTime2); // Compare actual P2 time to expected

            if (diff > SYNC_THRESHOLD_DRIFT) {
                console.log(`Drift Check: P1=${time1.toFixed(2)}, P2=${time2.toFixed(2)}, Offset=${syncOffsetSeconds.toFixed(2)}, ExpectedP2=${expectedTime2.toFixed(2)}. Diff=${diff.toFixed(2)} > ${SYNC_THRESHOLD_DRIFT}. Syncing P2->Expected.`);
                setSyncing(true); // ----- LOCK -----
                player2.seekTo(expectedTime2, true); // Seek P2 to expected offset time
                clearSyncingTimeout(150); // ----- UNLOCK after short delay -----
            }
        } else {
            stopSyncTimer(); // Stop if not both playing
        }
    } catch (e) {
        console.warn("Error during sync check (drift):", e);
        stopSyncTimer();
    }
}

// --- Helper functions for isSyncing flag --- (Internal sync lock)
function setSyncing(status) {
    isSyncing = status;
    if (status && syncTimeout) { clearTimeout(syncTimeout); syncTimeout = null; }
}
function clearSyncingTimeout(delay = 250) {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => { isSyncing = false; syncTimeout = null; }, delay);
}

// --- UI Interaction Logic ---

// Update status message (Handles Offset Display)
function updateSyncStatusMessage() {
    if (!statusElement) return;
    if (playersReady < 2) return; // Don't override loading messages

    if (isSyncGloballyEnabled) {
        let offsetMsg = "";
        // Only show offset if it's meaningfully different from zero
        if (Math.abs(syncOffsetSeconds) > 0.1) {
           const sign = syncOffsetSeconds > 0 ? "+" : ""; // Add plus sign for positive offsets
           offsetMsg = ` (Offset: P2 ${sign}${syncOffsetSeconds.toFixed(2)}s)`;
        }
        statusElement.textContent = `Sync Enabled: Playback controls linked.${offsetMsg}`;
    } else {
        statusElement.textContent = 'Sync Disabled: Controls are independent. Adjust videos and re-enable sync.';
    }
}

// Setup ALL button/control listeners
function setupButtonListeners() {
    // --- Setup Load Button Listener ---
    if (loadBtn) {
        loadBtn.onclick = loadVideos;
        console.log("Load Videos button listener attached.");
    } else {
        console.error("Load Videos button not found during listener setup!");
    }

    // --- Setup Toggle View Button Listener ---
    if (toggleViewBtn && mainContainer) {
         toggleViewBtn.onclick = () => {
            console.log("Toggle view button clicked.");
            mainContainer.classList.toggle('controls-hidden');
            document.body.classList.toggle('fullscreen-active');
            const isHidden = mainContainer.classList.contains('controls-hidden');
            // Update button text/icon/aria state
            if (isHidden) {
                toggleViewBtn.innerHTML = '<i class="fas fa-eye"></i> Show Controls';
                toggleViewBtn.title = "Show Controls View";
                toggleViewBtn.setAttribute('aria-pressed', 'true');
            } else {
                toggleViewBtn.innerHTML = '<i class="fas fa-eye-slash"></i> Hide Controls';
                toggleViewBtn.title = "Hide Controls View";
                toggleViewBtn.setAttribute('aria-pressed', 'false');
            }
            console.log("Fullscreen active:", document.body.classList.contains('fullscreen-active'));
        };
        console.log("Toggle view button listener attached.");
    } else {
        console.warn("Toggle view button or main container not found during listener setup.");
    }

    // --- Setup Sync Toggle Checkbox Listener ---
    if (syncToggleCheckbox) {
        syncToggleCheckbox.onchange = () => {
            isSyncGloballyEnabled = syncToggleCheckbox.checked;
            console.log("Global Sync Enabled Toggled:", isSyncGloballyEnabled);

            if (!isSyncGloballyEnabled) {
                // DISABLING sync: Stop drift timer
                stopSyncTimer();
                console.log("Sync Disabled: Drift timer stopped.");
            } else {
                // RE-ENABLING sync: Calculate and store the current offset
                console.log("Sync Re-enabled: Calculating offset...");
                if (playersReady === 2 && player1 && player2 &&
                    typeof player1.getCurrentTime === 'function' && typeof player2.getCurrentTime === 'function') {
                     try {
                         const time1 = player1.getCurrentTime();
                         const time2 = player2.getCurrentTime();
                         syncOffsetSeconds = time2 - time1; // Calculate and store offset (P2 - P1)
                         console.log(`  - P1 Time: ${time1.toFixed(2)}, P2 Time: ${time2.toFixed(2)}`);
                         console.log(`  - Calculated Offset (P2 - P1): ${syncOffsetSeconds.toFixed(2)}s`);

                         // Restart drift timer ONLY if both players are currently playing
                         const state1 = player1.getPlayerState();
                         const state2 = player2.getPlayerState();
                         if (state1 === YT.PlayerState.PLAYING && state2 === YT.PlayerState.PLAYING) {
                             startSyncTimer();
                         } else {
                             stopSyncTimer(); // Ensure it's stopped otherwise
                         }
                     } catch (e) {
                         console.warn("Error calculating offset on re-enable:", e);
                         syncOffsetSeconds = 0; // Reset offset on error
                         stopSyncTimer(); // Stop timer on error
                     }
                } else {
                    console.log("  - Could not calculate offset (players not ready/valid). Offset remains 0.");
                    syncOffsetSeconds = 0; // Ensure offset is 0 if calculation fails
                    stopSyncTimer(); // Ensure timer is stopped if we can't calculate offset
                }
            }
            updateSyncStatusMessage(); // Update the status text reflecting new state/offset
        };
         console.log("Sync toggle listener attached.");
    } else {
         console.warn("Sync toggle checkbox not found during listener setup.");
    }
}


// --- Initial Setup ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded. Setting up initial state and listeners.");

    // Initial button states
    if (loadBtn) { loadBtn.disabled = true; }
    // Initial view states
    if (mainContainer) mainContainer.classList.remove('controls-hidden');
     document.body.classList.remove('fullscreen-active');
     if (toggleViewBtn) toggleViewBtn.setAttribute('aria-pressed', 'false');
    // Initial sync states
    isSyncGloballyEnabled = true;
    syncOffsetSeconds = 0; // Ensure offset is 0 initially
    if (syncToggleCheckbox) { syncToggleCheckbox.checked = true; }

    // Setup listeners AFTER setting initial states
    setupButtonListeners();
});

console.log("Initial script execution finished.");