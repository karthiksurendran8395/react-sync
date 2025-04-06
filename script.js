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
let syncInterval = null;
const SYNC_THRESHOLD_DRIFT = 1.0; // Max allowed drift (seconds) before correction during playback
const SYNC_THRESHOLD_SEEK = 0.5; // Max allowed diff (seconds) before seeking on play/pause
const SYNC_INTERVAL_MS = 1500; // How often to check for drift (milliseconds)
let syncTimeout = null; // Timeout handle for releasing the isSyncing lock


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
// This function is called automatically when the API script has loaded
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
    // Ensure all necessary DOM elements are present
    if (!videoId1Input || !videoId2Input || !statusElement || !loadBtn || !syncToggleCheckbox) {
        console.error("Required elements missing for loadVideos.");
        if (statusElement) statusElement.textContent = "Error: UI elements missing.";
        return;
    }

    // Extract video IDs using the helper function
    const videoId1 = extractVideoId(videoId1Input.value);
    const videoId2 = extractVideoId(videoId2Input.value);

    // Validate the extracted IDs
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
    loadBtn.disabled = true; // Disable button while loading

    // --- Reset State Before Loading New Videos ---
    playersReady = 0;
    isSyncing = false; // Reset internal sync lock
    if (syncTimeout) clearTimeout(syncTimeout); // Clear any pending sync lock release
    syncTimeout = null;
    stopSyncTimer(); // Stop any active drift check interval
    destroyPlayers(); // Remove existing player instances and iframes
    isSyncGloballyEnabled = true; // Reset master sync switch to ON
    syncOffsetSeconds = 0; // Reset time offset to zero
    syncToggleCheckbox.checked = true; // Reset UI checkbox to checked
    console.log("State reset for load: Global Sync ON, Offset 0s");
    // --- End Reset State ---

    // Create New Player Instances using the YT.Player constructor
    try {
        player1 = new YT.Player('player1', {
            height: '360', // Dimensions are now primarily controlled by CSS aspect-ratio
            width: '640',
            videoId: videoId1,
            playerVars: {
                'playsinline': 1, // Important for mobile playback without fullscreen
                'enablejsapi': 1 // Required to control player via JavaScript
            },
            events: {
                'onReady': onPlayerReady,
                'onStateChange': onPlayerStateChange
            }
        });
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
    } catch (error) {
        console.error("Error creating YouTube players:", error);
        if (statusElement) statusElement.textContent = "Error loading players. Check console.";
        // Attempt to re-enable load button on error
        if(loadBtn) loadBtn.disabled = false;
    }
}

// Function to properly destroy existing player instances
function destroyPlayers() {
    console.log("Destroying existing players...");
    stopSyncTimer(); // Ensure sync timer is stopped
    if (syncTimeout) clearTimeout(syncTimeout); // Clear pending sync lock release
    syncTimeout = null;
    isSyncing = false; // Reset internal sync lock flag

    // Safely destroy player instances if they exist and have the destroy method
    if (player1 && typeof player1.destroy === 'function') {
        try { player1.destroy(); } catch (e) { console.warn("Error destroying player1:", e)}
        player1 = null;
    }
    if (player2 && typeof player2.destroy === 'function') {
        try { player2.destroy(); } catch (e) { console.warn("Error destroying player2:", e)}
        player2 = null;
    }

    // Clear the placeholder divs to remove any leftover iframe elements
    const p1Element = document.getElementById('player1');
    const p2Element = document.getElementById('player2');
    if (p1Element) p1Element.innerHTML = ''; // Clear content
    if (p2Element) p2Element.innerHTML = '';
}

// Event handler called when a player is ready to be controlled
function onPlayerReady(event) {
    playersReady++;
    const playerName = event.target === player1 ? "Player 1 (Left)" : "Player 2 (Right)";
    console.log(`${playerName} is Ready. Total ready: ${playersReady}`);

    if (playersReady === 2) {
        // Both players are now ready
        if (statusElement) statusElement.textContent = 'Players Ready.'; // Initial status
        updateSyncStatusMessage(); // Update status based on sync state & offset
        if (loadBtn) {
            loadBtn.disabled = false; // Re-enable load button
            console.log("Load button re-enabled (both players ready).");
        }
    } else if (playersReady < 2) {
        // Still waiting for the other player
        if (statusElement) statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
    }
}

// Event handler called when a player's state changes (playing, paused, etc.)
function onPlayerStateChange(event) {
    // --- Guard Clauses: Exit early if conditions aren't met ---
    // 1. If global sync is manually disabled by the user
    if (!isSyncGloballyEnabled) {
        const newState = event.data;
        // If sync is off, but the user manually pauses/ends/buffers, stop the drift timer
        // to prevent incorrect sync if re-enabled later while paused.
        if (newState === YT.PlayerState.PAUSED || newState === YT.PlayerState.ENDED || newState === YT.PlayerState.BUFFERING) {
             stopSyncTimer();
        }
        return; // Do not proceed with synchronization
    }
    // 2. If we are already in the middle of a sync operation (prevents loops)
    if (isSyncing) { return; }
    // 3. If both players are not yet ready
    if (playersReady < 2) { return; }
    // 4. If player instances are somehow invalid (shouldn't happen often)
    if (!player1 || !player2) { return; }
    // --- End Guard Clauses ---

    const sourcePlayer = event.target; // The player that triggered the event
    const targetPlayer = (sourcePlayer === player1) ? player2 : player1; // The *other* player

    // Check if the target player is valid and has necessary methods
    if (!targetPlayer || typeof targetPlayer.getPlayerState !== 'function') {
        console.warn("Target player not available or invalid during state change."); return;
    }

    let newState = -99, sourceTime = 0;
    try {
        // Get the new state and current time from the source player
        newState = event.data;
        sourceTime = sourcePlayer.getCurrentTime();
        console.log(`State Change (Sync ON) by ${sourcePlayer === player1 ? 'P1':'P2'}: ${getPlayerStateName(newState)} @ ${sourceTime.toFixed(2)}s`);
    } catch(e) {
        console.warn(`Error getting state or time from source player:`, e); return; // Exit if we can't get essential info
    }

    // --- Start Synchronization Process ---
    setSyncing(true); // *** LOCK: Set the internal flag to prevent event loops ***
    // Call the core sync logic function, passing necessary info including the current offset
    syncTargetPlayer(targetPlayer, sourcePlayer, newState, sourceTime, syncOffsetSeconds);
    // *** UNLOCK (Delayed): Release the lock after a short delay ***
    // This allows the target player's state change event (if any) to fire without causing an immediate re-sync loop.
    clearSyncingTimeout(250); // 250ms delay
    // --- End Synchronization Process ---
}

// Helper function to get the string name of a player state code
function getPlayerStateName(stateCode) {
    for (const state in YT.PlayerState) {
        if (YT.PlayerState[state] === stateCode) { return state; }
    }
    return `UNKNOWN (${stateCode})`;
}

// Core function to synchronize the target player based on the source player's action
// Takes the current sync offset into account
function syncTargetPlayer(targetPlayer, sourcePlayer, sourceState, sourceTime, offset) {
    // Basic checks
    if (!targetPlayer || typeof targetPlayer.getPlayerState !== 'function' || !sourcePlayer) {
        console.warn("Sync aborted: Invalid players provided to syncTargetPlayer."); return;
    }

    let targetState = -99;
    try {
        targetState = targetPlayer.getPlayerState(); // Get the current state of the target
    } catch(e) {
        console.warn("Sync aborted: Error getting target player state:", e); return;
    }

    const targetName = targetPlayer === player1 ? "P1" : "P2"; // For logging
    let targetSeekTime; // The calculated time the target player should be at

    try {
        switch (sourceState) {
            case YT.PlayerState.PLAYING:
                // Calculate the expected time for the target player based on source time and offset
                if (sourcePlayer === player1) { targetSeekTime = sourceTime + offset; } // P2 = P1 + offset
                else { targetSeekTime = sourceTime - offset; } // P1 = P2 - offset

                // Check if target player is significantly out of sync
                let currentTargetTime = 0; try { currentTargetTime = targetPlayer.getCurrentTime(); } catch (e) {}
                const timeDiffPlaying = Math.abs(currentTargetTime - targetSeekTime);

                // If difference exceeds threshold, seek the target player
                if (timeDiffPlaying > SYNC_THRESHOLD_SEEK) {
                    console.log(`Syncing ${targetName} seek to ${targetSeekTime.toFixed(2)}s (Diff: ${timeDiffPlaying.toFixed(2)}s)`);
                    targetPlayer.seekTo(targetSeekTime, true); // true allows seeking ahead
                }

                // If target isn't already playing or buffering, play it
                if (targetState !== YT.PlayerState.PLAYING && targetState !== YT.PlayerState.BUFFERING) {
                    console.log(`Syncing ${targetName} playVideo`);
                    targetPlayer.playVideo();
                }
                // Start the drift check timer since players should be playing
                startSyncTimer();
                break;

            case YT.PlayerState.PAUSED:
                stopSyncTimer(); // Stop checking for drift when paused
                // If target isn't already paused, pause it
                if (targetState !== YT.PlayerState.PAUSED) {
                    console.log(`Syncing ${targetName} pauseVideo`);
                    targetPlayer.pauseVideo();
                }

                // Calculate the target seek time based on source pause time and offset
                if (sourcePlayer === player1) { targetSeekTime = sourceTime + offset; }
                else { targetSeekTime = sourceTime - offset; }

                // Seek the target player *after a short delay* to ensure pause registered
                // Only seek if the target is actually paused when the timeout runs
                setTimeout(() => {
                    if (playersReady === 2 && targetPlayer && typeof targetPlayer.seekTo === 'function') {
                        try {
                            if(targetPlayer.getPlayerState() === YT.PlayerState.PAUSED){
                                console.log(`Syncing ${targetName} seek (post-pause) to ${targetSeekTime.toFixed(2)}s`);
                                targetPlayer.seekTo(targetSeekTime, true);
                            }
                        } catch (e) { console.warn(`Error seeking ${targetName} in pause timeout:`, e); }
                    }
                }, 150); // 150ms delay for seek after pause
                break;

            case YT.PlayerState.BUFFERING:
                 // If one player buffers, pause the other to wait for it
                stopSyncTimer(); // Stop drift check during buffering
                if (targetState === YT.PlayerState.PLAYING) {
                    console.log(`Syncing ${targetName} pauseVideo (due to source buffering)`);
                    targetPlayer.pauseVideo();
                }
                break;

            case YT.PlayerState.ENDED:
                stopSyncTimer(); // Stop drift check at end
                 // If target isn't already paused or ended, pause it
                if (targetState !== YT.PlayerState.PAUSED && targetState !== YT.PlayerState.ENDED) {
                     console.log(`Syncing ${targetName} pauseVideo (due to source ended)`);
                    targetPlayer.pauseVideo();
                }
                // Optionally seek target to its corresponding end time (or source's end time + offset)
                // This might be less critical but keeps them aligned if one seeks back from the end
                try {
                    if (sourcePlayer === player1) { targetSeekTime = sourceTime + offset; }
                    else { targetSeekTime = sourceTime - offset; }
                    console.log(`Syncing ${targetName} seek (post-end) to ${targetSeekTime.toFixed(2)}s`);
                    targetPlayer.seekTo(targetSeekTime, true);
                } catch(e) { console.warn(`Error seeking ${targetName} on ENDED state:`, e); }
                break;

             case YT.PlayerState.CUED: // Video loaded but not started
                 stopSyncTimer();
                 // If target started playing prematurely, pause it
                 if (targetState === YT.PlayerState.PLAYING) {
                     console.log(`Syncing ${targetName} pauseVideo (due to source cued)`);
                     targetPlayer.pauseVideo();
                 }
                 break;

             // Other states (UNSTARTED = -1) are generally handled implicitly
             // or don't require immediate action on the other player.
        }
    } catch (error) {
        console.error(`Error during syncTargetPlayer action (State: ${getPlayerStateName(sourceState)}):`, error);
        stopSyncTimer(); // Stop timer on error just in case
    }
}

// --- Sync Timer Logic (Periodic Drift Check - Uses Offset) ---

// Start the interval timer to periodically check for time drift between players
function startSyncTimer() {
    // Don't start if sync is globally off or timer is already running
    if (!isSyncGloballyEnabled || syncInterval) { return; }
    stopSyncTimer(); // Clear any existing timer first
    console.log(`Starting sync timer (Interval: ${SYNC_INTERVAL_MS}ms)`);
    syncInterval = setInterval(checkAndSyncTime, SYNC_INTERVAL_MS);
}

// Stop the interval timer
function stopSyncTimer() {
    if (syncInterval) {
        console.log("Stopping sync timer.");
        clearInterval(syncInterval);
        syncInterval = null;
    }
}

// Function executed by the interval timer to check and correct time drift
function checkAndSyncTime() {
    // --- Guard Clauses ---
    // Stop checking if sync is disabled globally
    if (!isSyncGloballyEnabled) { stopSyncTimer(); return; }
    // Don't check if we're already in a sync operation, players aren't ready, or players are invalid
    if (isSyncing || playersReady < 2 || !player1 || !player2 ||
         typeof player1.getPlayerState !== 'function' || typeof player2.getPlayerState !== 'function') {
        return;
    }
    // --- End Guard Clauses ---

    try {
        const state1 = player1.getPlayerState();
        const state2 = player2.getPlayerState();

        // Only check for drift if *both* players are currently playing
        if (state1 === YT.PlayerState.PLAYING && state2 === YT.PlayerState.PLAYING) {
            const time1 = player1.getCurrentTime();
            const time2 = player2.getCurrentTime();

            // Calculate the time player 2 *should* be at based on player 1's time and the stored offset
            const expectedTime2 = time1 + syncOffsetSeconds;
            // Calculate the difference between player 2's actual time and its expected time
            const diff = time2 - expectedTime2; // Use signed difference for logging clarity
            const absDiff = Math.abs(diff);

            // If the absolute difference exceeds the drift threshold, correct player 2's time
            if (absDiff > SYNC_THRESHOLD_DRIFT) {
                console.log(`Drift Check: P1=${time1.toFixed(2)}, P2=${time2.toFixed(2)}, Expected P2=${expectedTime2.toFixed(2)}. Diff=${diff.toFixed(2)}s > ${SYNC_THRESHOLD_DRIFT}. Syncing P2.`);
                setSyncing(true); // *** LOCK ***
                player2.seekTo(expectedTime2, true); // Seek P2 to the expected time
                clearSyncingTimeout(150); // *** UNLOCK (Delayed) ***
            }
        } else {
            // If players are not both playing, stop the drift timer
            stopSyncTimer();
        }
    } catch (e) {
        console.warn("Error during periodic sync check (drift):", e);
        stopSyncTimer(); // Stop timer on error
    }
}

// --- Helper functions for managing the `isSyncing` flag (Internal sync lock) ---

// Sets the isSyncing flag (acts as a lock)
// Clears any existing unlock timeout if we're setting the lock again
function setSyncing(status) {
    isSyncing = status;
    if (status && syncTimeout) { // If locking, clear any pending unlock timeout
        clearTimeout(syncTimeout);
        syncTimeout = null;
    }
    // console.log(`isSyncing set to: ${status}`); // Optional: for debugging locks
}

// Sets a timeout to release the isSyncing lock after a specified delay
function clearSyncingTimeout(delay = 250) {
    if (syncTimeout) clearTimeout(syncTimeout); // Clear previous timeout if any
    syncTimeout = setTimeout(() => {
        // console.log(`isSyncing lock released after ${delay}ms timeout.`); // Optional: for debugging locks
        isSyncing = false;
        syncTimeout = null;
    }, delay);
}

// --- UI Interaction Logic ---

// Update the status message area, showing sync state and offset if applicable
function updateSyncStatusMessage() {
    if (!statusElement) return;
    // Don't overwrite critical messages like loading errors or API status
    if (playersReady < 2 && statusElement.textContent.includes("Loading") || statusElement.textContent.includes("Error")) return;

    if (isSyncGloballyEnabled) {
        let offsetMsg = "";
        // Display the offset if it's significantly different from zero
        if (Math.abs(syncOffsetSeconds) > 0.1) {
           const sign = syncOffsetSeconds > 0 ? "+" : ""; // Add '+' for positive offsets
           offsetMsg = ` (Offset: P2 ${sign}${syncOffsetSeconds.toFixed(2)}s)`;
        }
        statusElement.textContent = `Sync Enabled: Playback controls linked.${offsetMsg}`;
    } else {
        statusElement.textContent = 'Sync Disabled: Controls are independent. Adjust videos and re-enable sync to set new offset.';
    }
}

// Setup event listeners for all interactive UI elements
function setupButtonListeners() {
    // Load Videos Button Listener
    if (loadBtn) {
        loadBtn.onclick = loadVideos;
        console.log("Load Videos listener attached.");
    } else { console.error("Load Videos button not found!"); }

    // Toggle View (Hide/Show Controls) Button Listener
    if (toggleViewBtn && mainContainer) {
         toggleViewBtn.onclick = () => {
            console.log("Toggle view button clicked.");
            // Toggle classes on relevant elements
            mainContainer.classList.toggle('controls-hidden');
            document.body.classList.toggle('fullscreen-active'); // For body-level changes like padding/bg

            const isHidden = mainContainer.classList.contains('controls-hidden');
            // Update button text, icon, title, and accessibility state
            if (isHidden) {
                toggleViewBtn.innerHTML = '<i class="fas fa-eye"></i> Show Controls';
                toggleViewBtn.title = "Show Controls View";
                toggleViewBtn.setAttribute('aria-pressed', 'true');
            } else {
                toggleViewBtn.innerHTML = '<i class="fas fa-eye-slash"></i> Hide Controls';
                toggleViewBtn.title = "Hide Controls View";
                toggleViewBtn.setAttribute('aria-pressed', 'false');
            }
            // Optional: Force redraw/reflow if transitions glitch, maybe resize players slightly
             window.dispatchEvent(new Event('resize'));
        };
        console.log("Toggle view listener attached.");
    } else { console.warn("Toggle view button or main container not found."); }

    // Sync Enabled/Disabled Checkbox Listener
    if (syncToggleCheckbox) {
        syncToggleCheckbox.onchange = () => {
            isSyncGloballyEnabled = syncToggleCheckbox.checked; // Update the global state variable
            console.log("Global Sync Enabled Toggled:", isSyncGloballyEnabled);

            if (!isSyncGloballyEnabled) {
                // --- Actions when DISABLING sync ---
                stopSyncTimer(); // Stop the periodic drift check immediately
                console.log("Sync Disabled: Drift timer stopped.");
                // Offset remains as it was, status message will update below.
            } else {
                // --- Actions when RE-ENABLING sync ---
                console.log("Sync Re-enabled: Calculating and storing current time offset...");
                // Only calculate offset if both players are ready and valid
                if (playersReady === 2 && player1 && player2 &&
                    typeof player1.getCurrentTime === 'function' && typeof player2.getCurrentTime === 'function') {
                     try {
                         const time1 = player1.getCurrentTime();
                         const time2 = player2.getCurrentTime();
                         // Calculate and STORE the new offset (P2 time relative to P1 time)
                         syncOffsetSeconds = time2 - time1;
                         console.log(`  - Calculated Offset (P2 - P1): ${syncOffsetSeconds.toFixed(2)}s`);

                         // Restart the drift timer ONLY if both players are currently playing
                         const state1 = player1.getPlayerState();
                         const state2 = player2.getPlayerState();
                         if (state1 === YT.PlayerState.PLAYING && state2 === YT.PlayerState.PLAYING) {
                             console.log("  - Both players playing, starting drift timer.");
                             startSyncTimer();
                         } else {
                             console.log("  - Players not both playing, drift timer remains stopped.");
                             stopSyncTimer(); // Ensure it's stopped otherwise
                         }
                     } catch (e) {
                         console.warn("Error calculating offset on re-enable:", e);
                         syncOffsetSeconds = 0; // Reset offset on error
                         stopSyncTimer();
                     }
                } else {
                    // Cannot calculate offset if players aren't ready
                    console.log("  - Could not calculate offset (players not ready/valid). Offset remains 0.");
                    syncOffsetSeconds = 0; // Ensure offset is 0 if calculation fails
                    stopSyncTimer();
                }
            }
            // Update the status message to reflect the new state (Enabled/Disabled and offset)
            updateSyncStatusMessage();
        };
        console.log("Sync toggle listener attached.");
    } else { console.warn("Sync toggle checkbox not found."); }
}

// --- Initial Setup on DOM Load ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded. Setting up initial state and listeners.");

    // Set initial state of UI elements and JS variables
    if (loadBtn) { loadBtn.disabled = true; } // Disabled until API is ready
    if (mainContainer) mainContainer.classList.remove('controls-hidden'); // Start with controls visible
    document.body.classList.remove('fullscreen-active'); // Ensure body style is normal
    if (toggleViewBtn) { // Set initial state for toggle button
        toggleViewBtn.innerHTML = '<i class="fas fa-eye-slash"></i> Hide Controls';
        toggleViewBtn.title = "Hide Controls View";
        toggleViewBtn.setAttribute('aria-pressed', 'false');
    }
    isSyncGloballyEnabled = true; // Sync is ON by default
    syncOffsetSeconds = 0; // No offset initially
    if (syncToggleCheckbox) { syncToggleCheckbox.checked = true; } // Match UI to the default state

    // Attach all event listeners after setting initial states
    setupButtonListeners();

    // Initial status message update (will likely be overwritten by API loading message)
    updateSyncStatusMessage();
});

console.log("Initial script execution finished. Waiting for DOMContentLoaded and YouTube API Ready...");