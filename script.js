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
    // Input validation
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

    // Reset State
    playersReady = 0;
    isRecreating = false; // Ensure not in recreating state on fresh load
    stopDriftLogTimer();
    stopUiUpdateTimer();
    destroyPlayers();
    isSyncGloballyEnabled = true; // Reset sync state
    syncOffsetSeconds = 0;
    overlapStartP1 = 0; // Reset overlap state
    overlapEndP1 = Infinity;
    overlapDuration = 0;
    if (syncToggleCheckbox) syncToggleCheckbox.checked = true; // Reset checkbox
    setCentralControlsEnabled(false); // Disable central controls initially

    // Store IDs for potential recreation
    storedVideoId1 = videoId1;
    storedVideoId2 = videoId2;

    // Determine initial controls based on checkbox
    const initialControls = syncToggleCheckbox.checked ? 0 : 1;
    console.log(`Initial load: Sync enabled = ${syncToggleCheckbox.checked}, Native controls = ${initialControls}`);

    // Create players
    createPlayer('player1', videoId1, initialControls);
    createPlayer('player2', videoId2, initialControls);
}

// Function to create a single player
function createPlayer(elementId, videoId, controlsValue) {
     console.log(`Creating player ${elementId} with Video ID ${videoId} and controls=${controlsValue}`);
     try {
         const playerVarOptions = {
            'playsinline': 1,
            'enablejsapi': 1,
            'controls': controlsValue,
            // 'origin': window.location.origin // Recommended for security if deploying
        };

         if (elementId === 'player1') {
             player1 = new YT.Player(elementId, {
                 height: '360', width: '640', videoId: videoId,
                 playerVars: playerVarOptions,
                 events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
             });
         } else {
             player2 = new YT.Player(elementId, {
                 height: '360', width: '640', videoId: videoId,
                 playerVars: playerVarOptions,
                 events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
             });
         }
     } catch (error) {
        console.error(`Error creating player ${elementId}:`, error);
        if (statusElement) statusElement.textContent = "Error loading players. Check console.";
        // if(loadBtn) loadBtn.disabled = false; // Potentially re-enable load button on error
     }
}

// Function to destroy players
function destroyPlayers() {
    console.log("Destroying existing players...");
    stopDriftLogTimer();
    stopUiUpdateTimer();
    isRecreating = false; // Ensure recreate flag is off when destroying

    // Safely destroy player instances
    if (player1 && typeof player1.destroy === 'function') {
        try { player1.destroy(); console.log("Player 1 destroyed."); } catch (e) { console.warn("Error destroying player1:", e)}
        player1 = null;
    }
    if (player2 && typeof player2.destroy === 'function') {
        try { player2.destroy(); console.log("Player 2 destroyed."); } catch (e) { console.warn("Error destroying player2:", e)}
        player2 = null;
    }

    // Clear placeholder divs
    const p1Element = document.getElementById('player1'); if (p1Element) p1Element.innerHTML = '';
    const p2Element = document.getElementById('player2'); if (p2Element) p2Element.innerHTML = '';
}

// --- onPlayerReady (Handles Initial Load and Post-Recreation) ---
function onPlayerReady(event) {
    playersReady++;
    const playerName = event.target === player1 ? "Player 1 (Left)" : "Player 2 (Right)";
    console.log(`${playerName} is Ready. Total ready: ${playersReady}`);

    if (playersReady === 2) {
        console.log("Both players ready.");
        if (loadBtn) loadBtn.disabled = false; // Re-enable load button after initial/recreate load

        if (isRecreating) {
            // --- Post-Recreation Logic ---
            console.log(`Recreation complete. Restoring state: P1 time=${tempStartTimeP1.toFixed(2)}, Captured Offset=${tempSyncOffset.toFixed(2)}`);
            syncOffsetSeconds = tempSyncOffset; // Restore the correct offset FIRST
            calculateOverlap(); // Calculate overlap based on restored state

            // Seek players to stored times, clamped within the new overlap
            const targetP1 = Math.max(overlapStartP1, Math.min(tempStartTimeP1, overlapEndP1));
            const targetP2 = targetP1 + syncOffsetSeconds;

            console.log(`Seeking post-recreate: P1 to ${targetP1.toFixed(2)}, P2 to ${targetP2.toFixed(2)} (Overlap: ${overlapStartP1.toFixed(2)}-${overlapEndP1.toFixed(2)})`);

            try {
                player1.seekTo(targetP1, true);
                player2.seekTo(Math.max(0, targetP2), true); // Clamp P2 >= 0

                // Pause both after seeking (use timeout for reliability)
                setTimeout(() => {
                    if (player1 && player2) { // Check players still exist
                        player1.pauseVideo();
                        player2.pauseVideo();
                        console.log("Players paused after recreation seek.");

                        // Apply final UI/sync state based on the checkbox
                        isSyncGloballyEnabled = syncToggleCheckbox.checked;

                        if (isSyncGloballyEnabled && overlapDuration > 0) { // Only enable if overlap exists
                            setCentralControlsEnabled(true);
                            updateCentralControllerUI(player1, YT.PlayerState.PAUSED); // Update UI to paused state
                            console.log("Central controls enabled post-recreation.");
                        } else {
                            setCentralControlsEnabled(false); // Keep disabled if no overlap or sync off
                             console.log(overlapDuration <= 0 ? "No overlap, keeping central controls disabled." : "Native controls enabled post-recreation.");
                        }
                        updateSyncStatusMessage(); // Update status message
                        startDriftLogTimer(); // Restart logger

                    } else {
                         console.warn("Players became invalid during post-recreation pause timeout.");
                    }
                    // End recreation process
                    isRecreating = false;
                    tempStartTimeP1 = 0;
                    tempSyncOffset = 0;
                    statusElement.textContent = "Players Ready."; // Clear reconfiguring message

                }, 200); // Slightly longer delay to ensure seek completes

            } catch (e) {
                 console.error("Error seeking/pausing players after recreation:", e);
                 isRecreating = false;
                 setCentralControlsEnabled(false); // Default to safe state
                 updateSyncStatusMessage();
                 startDriftLogTimer();
                 statusElement.textContent = "Error restoring state."; // Update status on error
            }

        } else {
            // --- Initial Load Logic ---
            console.log("Initial load complete.");
            isSyncGloballyEnabled = syncToggleCheckbox.checked; // Read initial state
            if (isSyncGloballyEnabled) {
                 try {
                     // Calculate initial offset & overlap
                     const time1 = player1.getCurrentTime();
                     const time2 = player2.getCurrentTime();
                     syncOffsetSeconds = time2 - time1; // Store the initial offset
                     console.log(`Initial Offset (P2 - P1): ${syncOffsetSeconds.toFixed(2)}s`);
                     calculateOverlap(); // Calculate overlap based on initial state

                     // Pause both and seek to start of overlap
                     player1.pauseVideo();
                     player2.pauseVideo();
                     const targetP1 = Math.max(0, overlapStartP1); // Start at overlap beginning
                     const targetP2Time = targetP1 + syncOffsetSeconds;
                     player1.seekTo(targetP1, true);
                     player2.seekTo(Math.max(0, targetP2Time), true); // Clamp P2 >= 0
                     console.log(`Initial seek: P1 to ${targetP1.toFixed(2)}, P2 to ${targetP2Time.toFixed(2)}`);

                     // Enable central controls ONLY if there is overlap
                     if (overlapDuration > 0) {
                         setCentralControlsEnabled(true);
                         // Update UI after pause/seek
                          setTimeout(() => updateCentralControllerUI(player1, YT.PlayerState.PAUSED), 100);
                     } else {
                         setCentralControlsEnabled(false); // Keep disabled if no overlap
                     }

                 } catch(e) {
                      console.error("Error during initial sync setup:", e);
                      setCentralControlsEnabled(false);
                 }
            } else {
                 // Sync disabled initially
                 setCentralControlsEnabled(false);
                 // Optionally pause both on initial load even if sync is off?
                 try { player1.pauseVideo(); player2.pauseVideo(); } catch(e){}
            }
            updateSyncStatusMessage();
            startDriftLogTimer();
            statusElement.textContent = "Players Ready."; // Set final status
        }
    } else if (playersReady < 2) {
        // Update status only if not recreating
        if (!isRecreating) {
             statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
        }
    }
}

// --- Calculate Overlap ---
function calculateOverlap() {
    // Reset values before calculation
    overlapStartP1 = 0;
    overlapEndP1 = Infinity;
    overlapDuration = 0;

    if (playersReady < 2 || !player1 || !player2 || typeof player1.getDuration !== 'function' || typeof player2.getDuration !== 'function') {
        console.log("Cannot calculate overlap: Players not ready or lack methods.");
        return;
    }

    try {
        const duration1 = player1.getDuration();
        const duration2 = player2.getDuration();

        // Check for valid positive durations
        if (duration1 <= 0 || duration2 <= 0) {
             console.log("Cannot calculate overlap: Durations invalid (<= 0).");
            return; // Keep overlapDuration at 0
        }

        // Calculate the start time of the overlap on Player 1's timeline
        // If P2 starts later (offset > 0), overlap starts at P1=0.
        // If P2 starts earlier (offset < 0), overlap starts when P2 reaches its 0, which is P1 = -offset.
        overlapStartP1 = Math.max(0, -syncOffsetSeconds);

        // Calculate the end time of the overlap on Player 1's timeline
        const endP1_limit1 = duration1; // When Player 1 ends
        const endP1_limit2 = duration2 - syncOffsetSeconds; // When Player 2 ends, translated to Player 1's timeline
        overlapEndP1 = Math.min(endP1_limit1, endP1_limit2);

        // Calculate overlap duration, ensure non-negative
        overlapDuration = Math.max(0, overlapEndP1 - overlapStartP1);

        console.log(`Overlap Calculated: P1 Duration=${duration1.toFixed(2)}, P2 Duration=${duration2.toFixed(2)}, Offset=${syncOffsetSeconds.toFixed(2)}`);
        console.log(`  -> Overlap in P1 Time: [${overlapStartP1.toFixed(2)}, ${overlapEndP1.toFixed(2)}] (Duration: ${overlapDuration.toFixed(2)}s)`);

        // If no overlap, log warning (controls disabled elsewhere based on this)
        if (overlapDuration <= 0) {
             console.warn("No overlap detected between videos with current offset.");
        }

    } catch (e) {
        console.error("Error calculating overlap:", e);
        // Reset values on error
        overlapStartP1 = 0;
        overlapEndP1 = Infinity;
        overlapDuration = 0;
    }
}


// --- onPlayerStateChange ---
function onPlayerStateChange(event) {
    // Ignore state changes during the recreation process
    if (isRecreating) {
        console.log("State change ignored during player recreation.");
        return;
    }
    if (playersReady < 2) return; // Don't do anything if both aren't ready

    const changedPlayer = event.target;
    const newState = event.data;

    // Update Central UI based ONLY on Player 1's state when sync is ON
    if (isSyncGloballyEnabled && changedPlayer === player1) {
        console.log(`P1 State Changed (Sync ON): ${getPlayerStateName(newState)} -> Updating Central UI`);
        updateCentralControllerUI(player1, newState); // Update central UI based on P1
    }
    // Log state changes when sync is OFF for debugging
    else if (!isSyncGloballyEnabled) {
         try {
             const sourceTime = changedPlayer.getCurrentTime();
             console.log(`State Change (Sync OFF) by ${changedPlayer === player1 ? 'P1':'P2'}: ${getPlayerStateName(newState)} @ ${sourceTime.toFixed(2)}s`);
         } catch(e) { /* ignore error getting time if player is invalid */ }
    }
    // Ignore P2 state changes when sync is ON for UI purposes
    else if (isSyncGloballyEnabled && changedPlayer === player2) {
        console.log(`P2 State Changed (Sync ON, Ignored for UI): ${getPlayerStateName(newState)}`);
    }
}


// --- Central Controls Logic ---
function setCentralControlsEnabled(enabled) {
    if (!centralControlsContainer) return;
    if (enabled) {
        centralControlsContainer.classList.remove('controls-disabled');
        // Ensure buttons are explicitly enabled
        if (centralPlayPauseBtn) centralPlayPauseBtn.disabled = false;
        if (centralSeekBar) centralSeekBar.disabled = false;
        if (centralSkipBackwardBtn) centralSkipBackwardBtn.disabled = false;
        if (centralSkipForwardBtn) centralSkipForwardBtn.disabled = false;
        console.log("Central controls ENABLED.");
    } else {
        centralControlsContainer.classList.add('controls-disabled');
        // Ensure buttons are explicitly disabled
        if (centralPlayPauseBtn) centralPlayPauseBtn.disabled = true;
        if (centralSeekBar) centralSeekBar.disabled = true;
        if (centralSkipBackwardBtn) centralSkipBackwardBtn.disabled = true;
        if (centralSkipForwardBtn) centralSkipForwardBtn.disabled = true;
        stopUiUpdateTimer(); // Stop UI updates when disabling controls
        console.log("Central controls DISABLED.");
        // Reset UI to default state when disabled
        if(centralPlayPauseBtn) centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
        if(centralSeekBar) {
            centralSeekBar.value = 0;
            centralSeekBar.max = 100; // Reset max to default
        }
        if(centralCurrentTime) centralCurrentTime.textContent = "0:00";
        if(centralDuration) centralDuration.textContent = "0:00";
    }
}

// --- MODIFIED: Update Central UI based on Overlap ---
function updateCentralControllerUI(player, state) {
    // Basic guard clauses
    if (!player || typeof player.getDuration !== 'function' || typeof player.getCurrentTime !== 'function' || !centralControlsContainer) return;
    // Only update if sync is on and controls are actually meant to be visible
    if (!isSyncGloballyEnabled || centralControlsContainer.classList.contains('controls-disabled')) return;

    // Ensure overlap is calculated (important check, might need recalculation if durations change unexpectedly)
    if (overlapDuration <= 0 || overlapEndP1 === Infinity) {
        calculateOverlap(); // Try to calculate
        if (overlapDuration <= 0) { // Re-check after calculation attempt
             console.log("Update UI skipped: No valid overlap duration calculated yet.");
             // Ensure controls are disabled if no overlap
             setCentralControlsEnabled(false);
             return;
        }
    }

    try {
        const currentTimeP1 = player.getCurrentTime();
        // Use passed state if available, otherwise get current state
        const currentState = state !== undefined ? state : player.getPlayerState();

        // --- Overlap Calculations for UI ---
        // Calculate current time *within* the overlap range [0, overlapDuration]
        // Clamp current P1 time within its overlap bounds first
        const clampedCurrentTimeP1 = Math.max(overlapStartP1, Math.min(currentTimeP1, overlapEndP1));
        const currentOverlapTime = clampedCurrentTimeP1 - overlapStartP1;

        // Update Seek Bar Max and Value (relative to overlap)
        if (centralSeekBar) {
            // Set max only if it changed significantly
            if (overlapDuration > 0 && Math.abs(centralSeekBar.max - overlapDuration) > 0.1) {
                centralSeekBar.max = overlapDuration; // Max is the overlap duration
            }
            // Update value if user isn't currently dragging it
            if (!centralSeekBar.matches(':active')) {
                 // Value is the time elapsed *within* the overlap
                 centralSeekBar.value = Math.max(0, Math.min(currentOverlapTime, overlapDuration)); // Clamp value too
            }
        }
        // Update Time Displays (relative to overlap)
        if (centralCurrentTime) centralCurrentTime.textContent = formatTime(currentOverlapTime);
        if (centralDuration) centralDuration.textContent = formatTime(overlapDuration);

        // Update Play/Pause Button Icon & Start/Stop UI Timer
        if (centralPlayPauseBtn) {
            if (currentState === YT.PlayerState.PLAYING) {
                centralPlayPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                centralPlayPauseBtn.title = "Pause";
                startUiUpdateTimer(); // Ensure timer runs for continuous updates
            } else {
                centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                centralPlayPauseBtn.title = "Play";
                stopUiUpdateTimer(); // Stop timer when not playing
                 // Ensure seek bar shows correct final time on pause/end etc., if user isn't dragging
                 if ((currentState === YT.PlayerState.PAUSED || currentState === YT.PlayerState.ENDED) && centralSeekBar && !centralSeekBar.matches(':active')) {
                     centralSeekBar.value = Math.max(0, Math.min(currentOverlapTime, overlapDuration));
                 }
            }
        }
    } catch (e) {
        console.warn("Error updating central controller UI:", e);
        stopUiUpdateTimer(); // Stop timer on error
    }
}

// Start the UI update timer
function startUiUpdateTimer() {
    if (uiUpdateInterval) return; // Already running
    stopUiUpdateTimer(); // Clear existing just in case
    console.log("Starting UI update timer.");
    uiUpdateInterval = setInterval(() => {
        // Update UI based on P1's current time ONLY if sync is still enabled and controls are visible
        if (player1 && isSyncGloballyEnabled && !centralControlsContainer.classList.contains('controls-disabled') && typeof player1.getCurrentTime === 'function') {
            updateCentralControllerUI(player1); // Update based on current P1 time/state
        } else {
            stopUiUpdateTimer(); // Stop if conditions not met
        }
    }, UI_UPDATE_INTERVAL_MS);
}

// Stop the UI update timer
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
            mainContainer.classList.toggle('controls-hidden'); document.body.classList.toggle('fullscreen-active'); const isHidden = mainContainer.classList.contains('controls-hidden');
            toggleViewBtn.innerHTML = isHidden ? '<i class="fas fa-eye"></i> Show Controls' : '<i class="fas fa-eye-slash"></i> Hide Controls'; toggleViewBtn.title = isHidden ? "Show Controls View" : "Hide Controls View"; toggleViewBtn.setAttribute('aria-pressed', isHidden ? 'true' : 'false'); window.dispatchEvent(new Event('resize'));
        }; console.log("Toggle view listener attached.");
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
                if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
                    console.log("Central Control: Pausing both players."); player1.pauseVideo(); player2.pauseVideo();
                } else {
                    console.log("Central Control: Playing both players."); player1.playVideo(); player2.playVideo();
                }
            } catch (e) { console.error("Error handling central play/pause:", e); }
        }; console.log("Central play/pause listener attached.");
    } else { console.warn("Central play/pause button not found."); }

    if (centralSeekBar) {
        // 'input' event: Update display time relative to overlap start
        centralSeekBar.addEventListener('input', () => {
             if (!player1 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
             const seekOverlapTime = parseFloat(centralSeekBar.value);
             if (centralCurrentTime) {
                 centralCurrentTime.textContent = formatTime(seekOverlapTime);
             }
        });
         // 'change' event: Calculate actual P1 time and seek both players
        centralSeekBar.addEventListener('change', () => {
            if (!player1 || !player2 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
            try {
                // Value from seek bar is time *within* the overlap [0, overlapDuration]
                const seekOverlapTime = parseFloat(centralSeekBar.value);
                // Calculate the corresponding absolute time for Player 1
                const seekTimeP1 = seekOverlapTime + overlapStartP1;
                // Ensure seekTimeP1 is within the valid overlap range for safety before calculating P2 time
                const clampedSeekTimeP1 = Math.max(overlapStartP1, Math.min(seekTimeP1, overlapEndP1));
                const seekTimeP2 = clampedSeekTimeP1 + syncOffsetSeconds;

                console.log(`Central Control Seek: OverlapValue=${seekOverlapTime.toFixed(2)} -> Seeking P1 to ${clampedSeekTimeP1.toFixed(2)}s, P2 to ${seekTimeP2.toFixed(2)}s`);

                const wasPlaying = player1.getPlayerState() === YT.PlayerState.PLAYING;
                // Optional: Pause before seek for potentially smoother sync
                if (wasPlaying) { player1.pauseVideo(); player2.pauseVideo(); }

                player1.seekTo(clampedSeekTimeP1, true);
                player2.seekTo(Math.max(0, seekTimeP2), true); // Clamp P2 seek time >= 0

                // Optional: Resume after seek if it was playing
                if (wasPlaying) {
                    setTimeout(() => { if (player1 && player2 && isSyncGloballyEnabled) { player1.playVideo(); player2.playVideo(); } }, 150);
                } else {
                    // Update UI once after seek if paused (using clamped time)
                     const finalOverlapTime = clampedSeekTimeP1 - overlapStartP1;
                     if (centralCurrentTime) centralCurrentTime.textContent = formatTime(finalOverlapTime);
                     if (centralSeekBar) centralSeekBar.value = finalOverlapTime;
                    // setTimeout(() => updateCentralControllerUI(player1), 50); // Alternative UI update
                }

            } catch (e) { console.error("Error handling central seek:", e); if (player1 && player1.getPlayerState() === YT.PlayerState.PLAYING) { startUiUpdateTimer(); } }
        });
        console.log("Central seek bar listeners attached.");
    } else { console.warn("Central seek bar not found."); }

    if (centralSkipForwardBtn) { centralSkipForwardBtn.onclick = () => handleSkip(5); console.log("Central skip forward listener attached."); }
    else { console.warn("Central skip forward button not found."); }
    if (centralSkipBackwardBtn) { centralSkipBackwardBtn.onclick = () => handleSkip(-5); console.log("Central skip backward listener attached."); }
    else { console.warn("Central skip backward button not found."); }
}


// --- CORRECTED: Handler for Sync Toggle Change (Handles Player Recreation & Offset) ---
function handleSyncToggleChange() {
    if (!syncToggleCheckbox || isRecreating) return; // Prevent action if already recreating

    const targetSyncStateEnabled = syncToggleCheckbox.checked;
    console.log("Sync toggle changed. Target state:", targetSyncStateEnabled ? "ENABLED" : "DISABLED");

    // Update global var for status message logic NOW
    isSyncGloballyEnabled = targetSyncStateEnabled;
    updateSyncStatusMessage(); // Update status message early

    // Only proceed with full logic if players exist AND are ready
    if (!player1 || !player2 || playersReady < 2) {
        console.log("Sync toggle changed, but players not ready. Will apply state when ready.");
        setCentralControlsEnabled(false); // Ensure controls are off if players aren't ready
        return;
    }

    // Always recreate when toggle changes after initial load to ensure correct 'controls' param
    console.log("Initiating player recreation due to sync toggle change...");
    isRecreating = true;
    statusElement.textContent = "Reconfiguring players...";
    setCentralControlsEnabled(false); // Disable central controls during process
    stopDriftLogTimer();
    stopUiUpdateTimer();

    // 1. Capture State (including CORRECT offset calculation if enabling)
    try {
        tempStartTimeP1 = player1.getCurrentTime();
        if (targetSyncStateEnabled) {
            // *** Calculate NEW offset based on current times ***
            const currentTimeP2 = player2.getCurrentTime();
            tempSyncOffset = currentTimeP2 - tempStartTimeP1; // This IS the new offset
            console.log(`Sync Enabling: Captured state & calculated NEW offset: P1 Time=${tempStartTimeP1.toFixed(2)}, Offset=${tempSyncOffset.toFixed(2)}`);
        } else {
            // If disabling, offset is irrelevant for restoring synced state
            tempSyncOffset = 0; // Resetting is cleaner.
             console.log(`Sync Disabling: Captured state: P1 Time=${tempStartTimeP1.toFixed(2)}`);
        }
        // Pause players before destroying (important!)
        player1.pauseVideo();
        player2.pauseVideo();
    } catch (e) {
        console.warn("Error capturing state before recreation:", e);
        tempStartTimeP1 = 0; // Reset captured time on error
        tempSyncOffset = 0; // Reset offset
    }

    // 2. Determine New Controls Value
    const newControlsValue = targetSyncStateEnabled ? 0 : 1; // 0=Hidden, 1=Shown
    console.log(`Target native controls value: ${newControlsValue}`);

    // 3. Destroy Old Players (Use timeout to allow pause command to process)
     setTimeout(() => {
        destroyPlayers(); // This also sets isRecreating = false internally
        isRecreating = true; // Set it back true for the recreation phase
        playersReady = 0;   // Reset ready count

         // 4. Recreate Players
        console.log("Recreating players now...");
        // Use storedVideoId1 and storedVideoId2 which were set during loadVideos
        if (storedVideoId1 && storedVideoId2) {
            createPlayer('player1', storedVideoId1, newControlsValue);
            createPlayer('player2', storedVideoId2, newControlsValue);
            // onPlayerReady will handle the rest when both players are ready again
        } else {
             console.error("Cannot recreate players: Stored video IDs are missing.");
             statusElement.textContent = "Error: Cannot reconfigure players.";
             isRecreating = false; // End recreate process on error
             if (loadBtn) loadBtn.disabled = false; // Allow user to reload
        }
     }, 150); // Delay before destroy/recreate (allow pause to register)
}


// --- MODIFIED: Handler for Skip Buttons (Considers Overlap) ---
function handleSkip(secondsToSkip) {
     // Check usability & ensure overlap has been calculated and is positive
     if (!player1 || !player2 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
     try {
         const currentTimeP1 = player1.getCurrentTime();
         // Calculate new target time based on P1
         const targetTimeP1 = currentTimeP1 + secondsToSkip;
         // Clamp the target time within the VALID OVERLAP range for P1 [overlapStartP1, overlapEndP1]
         const seekTimeP1 = Math.max(overlapStartP1, Math.min(targetTimeP1, overlapEndP1));
         // Calculate corresponding P2 time based on the *clamped* P1 time
         const seekTimeP2 = seekTimeP1 + syncOffsetSeconds;

         console.log(`Central Control Skip: ${secondsToSkip}s -> Clamped Seek P1 to ${seekTimeP1.toFixed(2)}s, P2 to ${seekTimeP2.toFixed(2)}s`);

         // Perform seeks
         player1.seekTo(seekTimeP1, true);
         player2.seekTo(Math.max(0, seekTimeP2), true); // Clamp P2 seek time >= 0

         // Update UI immediately based on the new P1 time relative to the overlap start
         const seekOverlapTime = seekTimeP1 - overlapStartP1;
         if(centralSeekBar) centralSeekBar.value = seekOverlapTime;
         if(centralCurrentTime) centralCurrentTime.textContent = formatTime(seekOverlapTime);

         // If paused, ensure the UI reflects the final state after a short delay
         // (This might already be covered by updateCentralControllerUI if called soon after)
         if (player1.getPlayerState() !== YT.PlayerState.PLAYING) {
              setTimeout(() => updateCentralControllerUI(player1), 50);
         }

     } catch (e) {
         console.error(`Error handling skip (${secondsToSkip}s):`, e);
     }
}

// --- Drift Monitoring Logic ---
function logDrift() {
     if (isRecreating || playersReady < 2 || !player1 || !player2 || typeof player1.getCurrentTime !== 'function' || typeof player2.getCurrentTime !== 'function') {
         return; // Skip logging during recreation or if players invalid
     }
    try {
        const time1 = player1.getCurrentTime();
        const time2 = player2.getCurrentTime();
        const actualOffset = time2 - time1;
        const drift = actualOffset - syncOffsetSeconds; // Compare against the stored offset

        console.log(
            `Drift Monitor | ` +
            `P1: ${time1.toFixed(3)}s | ` +
            `P2: ${time2.toFixed(3)}s | ` +
            `Actual Offset: ${actualOffset.toFixed(3)}s | ` +
            `Expected Offset: ${syncOffsetSeconds.toFixed(3)}s | ` + // Log the offset sync *should* aim for
            `Drift: ${drift.toFixed(3)}s`
        );

    } catch (e) { console.warn("Error during drift logging:", e); }
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


// --- UI Interaction Logic ---
function updateSyncStatusMessage() {
     if (!statusElement) return;
     // Show reconfiguring message if applicable
     if (isRecreating) { statusElement.textContent = "Reconfiguring players..."; return; }
     // Prevent overwriting API load/error messages if players not ready
     if (playersReady < 2 && (statusElement.textContent.includes("Loading") || statusElement.textContent.includes("Error"))) { return; }

     // Use the actual current state of the checkbox for the message
     const currentSyncEnabledState = syncToggleCheckbox ? syncToggleCheckbox.checked : isSyncGloballyEnabled;

     if (currentSyncEnabledState) {
         let offsetMsg = "";
         // Display offset only if sync is enabled, overlap exists, and offset is significant
         if (overlapDuration > 0 && Math.abs(syncOffsetSeconds) > 0.1) {
             const sign = syncOffsetSeconds > 0 ? "+" : "";
             offsetMsg = ` (Offset: P2 ${sign}${syncOffsetSeconds.toFixed(2)}s)`;
         }
         const controlsActive = centralControlsContainer && !centralControlsContainer.classList.contains('controls-disabled');

         if (playersReady < 2) {
             statusElement.textContent = `Sync Enabled: Waiting for players...${offsetMsg}`;
         } else if (overlapDuration <= 0) {
             // If sync is ON but no overlap, indicate this clearly
             statusElement.textContent = `Sync Enabled: No overlapping playtime detected.${offsetMsg}`;
         } else {
             // Sync ON, players ready, overlap exists
             statusElement.textContent = controlsActive
                                    ? `Sync Enabled: Central controls active.${offsetMsg}`
                                    : `Sync Enabled: Initializing...${offsetMsg}`;
         }
     } else {
         // Sync is disabled
         if (playersReady < 2) {
              statusElement.textContent = 'Sync Disabled: Waiting for players...';
         } else {
             statusElement.textContent = 'Sync Disabled: Use individual player controls. Re-enable sync to use central controls and set offset.';
         }
     }
}


// --- Initial Setup on DOM Load ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded. Setting up initial state and listeners.");

    if (loadBtn) { loadBtn.disabled = true; } // Disabled until API is ready
    if (mainContainer) mainContainer.classList.remove('controls-hidden'); // Start with controls visible
    document.body.classList.remove('fullscreen-active'); // Ensure body style is normal
    if (toggleViewBtn) { // Set initial state for toggle button
         toggleViewBtn.innerHTML = '<i class="fas fa-eye-slash"></i> Hide Controls';
         toggleViewBtn.title = "Hide Controls View";
         toggleViewBtn.setAttribute('aria-pressed', 'false');
    }
    // Set initial JS state based on checkbox default
    isSyncGloballyEnabled = syncToggleCheckbox ? syncToggleCheckbox.checked : true;
    syncOffsetSeconds = 0;
    overlapStartP1 = 0; overlapEndP1 = Infinity; overlapDuration = 0; // Init overlap state
    // Checkbox state is set in HTML
    setCentralControlsEnabled(false); // Ensure controls start disabled

    // Attach all event listeners after setting initial states
    setupButtonListeners();

    // Initial status message update
    updateSyncStatusMessage();
});

console.log("Initial script execution finished. Waiting for DOMContentLoaded and YouTube API Ready...");