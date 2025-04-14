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

// *** NEW: Sync Controls References ***
const syncControlsSection = document.getElementById('syncControlsSection');
const offsetInput = document.getElementById('offsetInput');
const applyOffsetBtn = document.getElementById('applyOffsetBtn');
const driftDisplay = document.getElementById('driftDisplay');


// Player instances
let player1 = null;
let player2 = null;
let playersReady = 0;

// --- Sync State Variables ---
let isSyncGloballyEnabled = true;
let syncOffsetSeconds = 0; // The TARGET offset

// --- Overlap Calculation State ---
let overlapStartP1 = 0; // The time on Player 1 where the overlap begins
let overlapEndP1 = Infinity; // The time on Player 1 where the overlap ends
let overlapDuration = 0; // The calculated duration of the overlap

// --- State Preservation During Recreate ---
let storedVideoId1 = '';
let storedVideoId2 = '';
let tempStartTimeP1 = 0; // Time to seek P1 to after recreation
let tempSyncOffset = 0; // Offset to use when calculating P2 seek time after recreation
let isRecreating = false; // Flag to indicate recreation is in progress

// --- Drift Monitoring Variables ---
let driftLogInterval = null; // Timer for *logging* drift AND updating drift UI
const DRIFT_LOG_INTERVAL_MS = 1000; // Log/update drift every 1 second (was 2s)

// --- Central Controller UI Update Timer ---
let uiUpdateInterval = null;
const UI_UPDATE_INTERVAL_MS = 250; // Update UI 4 times per second

// --- Helper Functions ---
function extractVideoId(input) {
    if (!input) return null;
    input = input.trim();
    const urlRegex = /(?:watch\?v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/;
    const match = input.match(urlRegex);
    if (match && match[1]) {
        return match[1];
    }
    const plainIdRegex = /^[a-zA-Z0-9_-]{11}$/;
    if (plainIdRegex.test(input)) {
        return input;
    }
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
        if (YT.PlayerState[state] === stateCode) {
            return state;
        }
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
        if (!videoId1) videoId1Input.focus();
        else videoId2Input.focus();
        return;
    }
    console.log("Loading videos with IDs:", videoId1, videoId2);
    statusElement.textContent = 'Loading videos...';
    loadBtn.disabled = true;
    playersReady = 0;
    isRecreating = false;
    stopDriftLogTimer();
    stopUiUpdateTimer();
    destroyPlayers();
    isSyncGloballyEnabled = true; // Reset sync toggle state
    syncOffsetSeconds = 0;
    overlapStartP1 = 0;
    overlapEndP1 = Infinity;
    overlapDuration = 0;
    if (syncToggleCheckbox) syncToggleCheckbox.checked = true; // Ensure checkbox reflects state
    setCentralControlsEnabled(false);
    setSyncControlsVisibility(false); // *** Hide sync controls on new load
    storedVideoId1 = videoId1;
    storedVideoId2 = videoId2;
    const initialControls = syncToggleCheckbox.checked ? 0 : 1;
    console.log(`Initial load: Sync enabled = ${syncToggleCheckbox.checked}, Native controls = ${initialControls}`);
    createPlayer('player1', videoId1, initialControls);
    createPlayer('player2', videoId2, initialControls);
}

function createPlayer(elementId, videoId, controlsValue) {
    console.log(`Creating player ${elementId} with Video ID ${videoId} and controls=${controlsValue}`);
    try {
        const playerVarOptions = {
            'playsinline': 1,
            'enablejsapi': 1,
            'controls': controlsValue,
        };
        if (elementId === 'player1') {
            player1 = new YT.Player(elementId, {
                height: '360',
                width: '640',
                videoId: videoId,
                playerVars: playerVarOptions,
                events: {
                    'onReady': onPlayerReady,
                    'onStateChange': onPlayerStateChange
                }
            });
        } else {
            player2 = new YT.Player(elementId, {
                height: '360',
                width: '640',
                videoId: videoId,
                playerVars: playerVarOptions,
                events: {
                    'onReady': onPlayerReady,
                    'onStateChange': onPlayerStateChange
                }
            });
        }
    } catch (error) {
        console.error(`Error creating player ${elementId}:`, error);
        if (statusElement) statusElement.textContent = "Error loading players. Check console.";
    }
}

function destroyPlayers() {
    console.log("Destroying existing players...");
    stopDriftLogTimer();
    stopUiUpdateTimer();
    isRecreating = false;
    if (player1 && typeof player1.destroy === 'function') {
        try {
            player1.destroy();
            console.log("Player 1 destroyed.");
        } catch (e) {
            console.warn("Error destroying player1:", e)
        }
        player1 = null;
    }
    if (player2 && typeof player2.destroy === 'function') {
        try {
            player2.destroy();
            console.log("Player 2 destroyed.");
        } catch (e) {
            console.warn("Error destroying player2:", e)
        }
        player2 = null;
    }
    const p1Element = document.getElementById('player1');
    if (p1Element) p1Element.innerHTML = '';
    const p2Element = document.getElementById('player2');
    if (p2Element) p2Element.innerHTML = '';
}

// --- onPlayerReady (Handles Initial Load and Post-Recreation) ---
function onPlayerReady(event) {
    playersReady++;
    const playerName = event.target === player1 ? "Player 1 (Left)" : "Player 2 (Right)";
    console.log(`${playerName} is Ready. Total ready: ${playersReady}`);

    if (playersReady === 2) {
        console.log("Both players ready.");
        if (loadBtn) loadBtn.disabled = false;

        if (isRecreating) {
            // --- Post-Recreation Logic ---
            console.log(`Recreation complete. Restoring state: P1 time=${tempStartTimeP1.toFixed(2)}, Captured Offset=${tempSyncOffset.toFixed(2)}`);
            syncOffsetSeconds = tempSyncOffset; // Restore the offset calculated BEFORE recreation
            calculateOverlap();
            updateOffsetInputValue(); // *** Update input field with restored offset
            const targetP1 = Math.max(overlapStartP1, Math.min(tempStartTimeP1, overlapEndP1));
            const targetP2 = targetP1 + syncOffsetSeconds;
            console.log(`Seeking post-recreate: P1 to ${targetP1.toFixed(2)}, P2 to ${targetP2.toFixed(2)} (Overlap: ${overlapStartP1.toFixed(2)}-${overlapEndP1.toFixed(2)})`);
            try {
                player1.seekTo(targetP1, true);
                player2.seekTo(Math.max(0, targetP2), true);
                setTimeout(() => { // Pause after seek
                    if (player1 && player2) {
                        player1.pauseVideo();
                        player2.pauseVideo();
                        console.log("Players paused after recreation seek.");
                        isSyncGloballyEnabled = syncToggleCheckbox.checked; // Re-read just in case
                        setSyncControlsVisibility(isSyncGloballyEnabled); // *** Show/Hide Sync Controls
                        if (isSyncGloballyEnabled && overlapDuration > 0) {
                            setCentralControlsEnabled(true);
                            updateCentralControllerUI(player1, YT.PlayerState.PAUSED);
                            console.log("Central controls enabled post-recreation.");
                        } else {
                            setCentralControlsEnabled(false);
                            console.log(overlapDuration <= 0 ? "No overlap, keeping central controls disabled." : "Native controls enabled post-recreation.");
                        }
                        updateSyncStatusMessage();
                        startDriftLogTimer(); // Start logging/updating drift
                    } else {
                        console.warn("Players became invalid during post-recreation pause timeout.");
                    }
                    isRecreating = false;
                    tempStartTimeP1 = 0;
                    tempSyncOffset = 0;
                    statusElement.textContent = "Players Ready.";
                }, 200);
            } catch (e) {
                console.error("Error seeking/pausing players after recreation:", e);
                isRecreating = false;
                setCentralControlsEnabled(false);
                setSyncControlsVisibility(isSyncGloballyEnabled);
                updateSyncStatusMessage();
                startDriftLogTimer();
                statusElement.textContent = "Error restoring state.";
            }
        } else {
            // --- Initial Load Logic ---
            console.log("Initial load complete.");
            isSyncGloballyEnabled = syncToggleCheckbox.checked;
            setSyncControlsVisibility(isSyncGloballyEnabled); // *** Show/Hide Sync Controls
            if (isSyncGloballyEnabled) {
                try {
                    // Pause first to get accurate times?
                    player1.pauseVideo();
                    player2.pauseVideo();

                    // Delay slightly to ensure pause registers before getting time
                    setTimeout(() => {
                        if (!player1 || !player2) return; // Check if players still exist
                        try {
                            const time1 = player1.getCurrentTime();
                            const time2 = player2.getCurrentTime();
                            syncOffsetSeconds = time2 - time1; // Calculate initial offset
                            console.log(`Initial Offset (P2 - P1): ${syncOffsetSeconds.toFixed(3)}s`);
                            updateOffsetInputValue(); // *** Update input field
                            calculateOverlap();
                            const targetP1 = Math.max(0, overlapStartP1);
                            const targetP2Time = targetP1 + syncOffsetSeconds;
                            player1.seekTo(targetP1, true);
                            player2.seekTo(Math.max(0, targetP2Time), true);
                            console.log(`Initial seek: P1 to ${targetP1.toFixed(2)}, P2 to ${targetP2Time.toFixed(2)}`);
                            if (overlapDuration > 0) {
                                setCentralControlsEnabled(true);
                                setTimeout(() => updateCentralControllerUI(player1, YT.PlayerState.PAUSED), 100);
                            } else {
                                setCentralControlsEnabled(false);
                            }
                            updateSyncStatusMessage();
                            startDriftLogTimer();
                            statusElement.textContent = "Players Ready.";
                        } catch(eInner) {
                             console.error("Error during initial sync setup (delayed part):", eInner);
                             setCentralControlsEnabled(false);
                             setSyncControlsVisibility(false);
                             statusElement.textContent = "Error setting up sync.";
                        }
                    }, 150); // Delay after pause

                } catch (e) {
                    console.error("Error during initial sync setup (outer):", e);
                    setCentralControlsEnabled(false);
                    setSyncControlsVisibility(false);
                     statusElement.textContent = "Error setting up sync.";
                }
            } else {
                // Sync disabled initially
                setCentralControlsEnabled(false);
                try {
                    player1.pauseVideo();
                    player2.pauseVideo();
                } catch (e) {}
                 updateSyncStatusMessage();
                 startDriftLogTimer(); // Start timer even if sync off, just won't update drift display
                 statusElement.textContent = "Players Ready.";
            }
        }
    } else if (playersReady < 2) {
        if (!isRecreating) {
            statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
        }
    }
}


// --- Calculate Overlap ---
function calculateOverlap() {
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
        if (duration1 <= 0 || duration2 <= 0) {
            console.log("Cannot calculate overlap: Durations invalid (<= 0).");
            return;
        }
        // Overlap starts when BOTH videos are playing
        // If P2 starts later (offset > 0), overlap starts at P1 time = 0
        // If P1 starts later (offset < 0), overlap starts at P1 time = -offset
        overlapStartP1 = Math.max(0, -syncOffsetSeconds);

        // Overlap ends when EITHER video finishes
        // P1 ends at time duration1
        // P2 ends at time duration2. The equivalent P1 time is duration2 - offset
        const endP1_limit1 = duration1;
        const endP1_limit2 = duration2 - syncOffsetSeconds;
        overlapEndP1 = Math.min(endP1_limit1, endP1_limit2);

        // Ensure start is not after end
        overlapEndP1 = Math.max(overlapStartP1, overlapEndP1);

        overlapDuration = Math.max(0, overlapEndP1 - overlapStartP1);

        console.log(`Overlap Calculated: P1 Duration=${duration1.toFixed(2)}, P2 Duration=${duration2.toFixed(2)}, Offset=${syncOffsetSeconds.toFixed(3)}`);
        console.log(`  -> Overlap in P1 Time: [${overlapStartP1.toFixed(3)}, ${overlapEndP1.toFixed(3)}] (Duration: ${overlapDuration.toFixed(3)}s)`);
        if (overlapDuration <= 0) {
            console.warn("No overlap detected between videos with current offset.");
            if (isSyncGloballyEnabled) {
                 // If sync is on but no overlap, disable central controls
                 setCentralControlsEnabled(false);
            }
        }
        updateCentralControllerUI(player1); // Update central controls based on new overlap
    } catch (e) {
        console.error("Error calculating overlap:", e);
        overlapStartP1 = 0;
        overlapEndP1 = Infinity;
        overlapDuration = 0;
    }
}


// --- onPlayerStateChange ---
function onPlayerStateChange(event) {
    if (isRecreating) {
        console.log("State change ignored during player recreation.");
        return;
    }
    if (playersReady < 2) return;
    const changedPlayer = event.target;
    const newState = event.data;
    if (isSyncGloballyEnabled && changedPlayer === player1) {
        console.log(`P1 State Changed (Sync ON): ${getPlayerStateName(newState)} -> Updating Central UI`);
        updateCentralControllerUI(player1, newState);
         // Ensure drift update continues even if paused
        if (newState === YT.PlayerState.PAUSED || newState === YT.PlayerState.ENDED) {
            logDrift(); // Update drift display one last time on pause/end
        }
    } else if (!isSyncGloballyEnabled) {
        try {
            const sourceTime = changedPlayer.getCurrentTime();
            console.log(`State Change (Sync OFF) by ${changedPlayer === player1 ? 'P1':'P2'}: ${getPlayerStateName(newState)} @ ${sourceTime.toFixed(2)}s`);
        } catch (e) {
            /* ignore */ }
    } else if (isSyncGloballyEnabled && changedPlayer === player2) {
        console.log(`P2 State Changed (Sync ON, Ignored for UI): ${getPlayerStateName(newState)}`);
    }
}

// --- Sync Controls UI Logic ---
function setSyncControlsVisibility(visible) {
    if (!syncControlsSection) return;
    if (visible && !mainContainer.classList.contains('controls-hidden')) { // Only show if sync enabled AND not in cinema mode
        syncControlsSection.classList.add('sync-controls-visible');
        // Update values when shown
        updateOffsetInputValue();
        logDrift(); // Update drift immediately when shown
    } else {
        syncControlsSection.classList.remove('sync-controls-visible');
        if (driftDisplay) driftDisplay.textContent = "N/A"; // Reset drift display when hidden
    }
}

function updateOffsetInputValue() {
    if (offsetInput) {
        // Format to 3 decimal places for clarity
        offsetInput.value = syncOffsetSeconds.toFixed(3);
    }
}

function applyCustomOffset() {
    if (!offsetInput || !player1 || !player2 || !isSyncGloballyEnabled) {
        console.warn("Cannot apply offset: Input missing, players not ready, or sync disabled.");
        return;
    }
    const newOffsetStr = offsetInput.value;
    const newOffset = parseFloat(newOffsetStr);

    if (isNaN(newOffset)) {
        console.error("Invalid offset value entered:", newOffsetStr);
        statusElement.textContent = "Error: Invalid offset value.";
        // Optional: revert input to current value
        updateOffsetInputValue();
        return;
    }

    console.log(`Applying new custom offset: ${newOffset.toFixed(3)}s`);
    syncOffsetSeconds = newOffset; // Update the global target offset

    try {
        // Recalculate overlap based on the NEW offset
        calculateOverlap();

        // Determine current P1 time to maintain position relative to P1
        const currentTimeP1 = player1.getCurrentTime();

        // Seek both players immediately to reflect the new offset relative to P1's current time
        // Clamp P1's target time within the *new* overlap boundaries
        const targetSeekP1 = Math.max(overlapStartP1, Math.min(currentTimeP1, overlapEndP1));
        const targetSeekP2 = targetSeekP1 + syncOffsetSeconds; // Use the NEW offset

        console.log(`Seeking after applying offset: P1 to ${targetSeekP1.toFixed(3)}, P2 to ${targetSeekP2.toFixed(3)}`);

        const wasPlaying = player1.getPlayerState() === YT.PlayerState.PLAYING;
         if (wasPlaying) {
             player1.pauseVideo(); // Pause briefly to ensure seek accuracy
             player2.pauseVideo();
         }

        player1.seekTo(targetSeekP1, true);
        player2.seekTo(Math.max(0, targetSeekP2), true); // Ensure P2 doesn't seek before 0

        if (wasPlaying) {
            // Resume playing after a short delay
            setTimeout(() => {
                if (player1 && player2 && isSyncGloballyEnabled) {
                    player1.playVideo();
                    player2.playVideo();
                }
            }, 150);
        }

        // Update UI elements immediately
        setCentralControlsEnabled(isSyncGloballyEnabled && overlapDuration > 0); // Re-evaluate central controls based on new overlap
        updateCentralControllerUI(player1); // Update central controller based on new state
        updateSyncStatusMessage(); // Update status message (might mention offset)
        logDrift(); // Update drift display immediately

    } catch (e) {
        console.error("Error applying custom offset and seeking:", e);
        statusElement.textContent = "Error applying new offset.";
        // Attempt to restore previous state? Might be complex.
        // For now, just log the error.
    }
}


// --- Central Controls Logic ---
function setCentralControlsEnabled(enabled) {
    if (!centralControlsContainer) return;
    if (enabled && isSyncGloballyEnabled && overlapDuration > 0) { // Added checks
        centralControlsContainer.classList.remove('controls-disabled');
        if (centralPlayPauseBtn) centralPlayPauseBtn.disabled = false;
        if (centralSeekBar) centralSeekBar.disabled = false;
        if (centralSkipBackwardBtn) centralSkipBackwardBtn.disabled = false;
        if (centralSkipForwardBtn) centralSkipForwardBtn.disabled = false;
        console.log("Central controls ENABLED.");
    } else {
        centralControlsContainer.classList.add('controls-disabled');
        if (centralPlayPauseBtn) centralPlayPauseBtn.disabled = true;
        if (centralSeekBar) centralSeekBar.disabled = true;
        if (centralSkipBackwardBtn) centralSkipBackwardBtn.disabled = true;
        if (centralSkipForwardBtn) centralSkipForwardBtn.disabled = true;
        stopUiUpdateTimer();
        console.log("Central controls DISABLED.", enabled ? "" : "(Reason: Sync Off or No Overlap)");
        // Reset UI elements when disabled
        if (centralPlayPauseBtn) centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
        if (centralSeekBar) {
            centralSeekBar.value = 0;
            centralSeekBar.max = 100; // Default max
        }
        if (centralCurrentTime) centralCurrentTime.textContent = "0:00";
        if (centralDuration) centralDuration.textContent = "0:00";
    }
}

function updateCentralControllerUI(player, state) {
    if (!player || typeof player.getDuration !== 'function' || typeof player.getCurrentTime !== 'function' || !centralControlsContainer) return;
    // Only update if sync is on AND controls are *supposed* to be enabled (overlap > 0)
    if (!isSyncGloballyEnabled || overlapDuration <= 0 || overlapEndP1 === Infinity) {
         // If called when it shouldn't be active, ensure controls are disabled
         if (!centralControlsContainer.classList.contains('controls-disabled')) {
             // calculateOverlap(); // Re-check overlap just in case
             // if (overlapDuration <= 0) { // Check again after calculation
                 console.log("Update UI skipped: No valid overlap duration for active central controls.");
                 setCentralControlsEnabled(false);
             // }
         }
        return;
    }
    // If we reach here, sync is ON and overlap EXISTS.

    try {
        const currentTimeP1 = player.getCurrentTime();
        const currentState = state !== undefined ? state : player.getPlayerState();

        // Calculate position within the overlap timeline
        const clampedCurrentTimeP1 = Math.max(overlapStartP1, Math.min(currentTimeP1, overlapEndP1));
        const currentOverlapTime = clampedCurrentTimeP1 - overlapStartP1;

        // Update Seek Bar
        if (centralSeekBar) {
             // Set max only if it differs significantly to avoid jitter
            if (overlapDuration > 0 && Math.abs(centralSeekBar.max - overlapDuration) > 0.1) {
                centralSeekBar.max = overlapDuration;
                console.log(`Central Seekbar Max updated to: ${overlapDuration.toFixed(3)}`);
            }
            // Update value only if user isn't actively dragging
            if (!centralSeekBar.matches(':active')) {
                 // Ensure value stays within 0 and max
                 const seekBarValue = Math.max(0, Math.min(currentOverlapTime, overlapDuration));
                centralSeekBar.value = seekBarValue;
            }
        }

        // Update Time Displays
        if (centralCurrentTime) centralCurrentTime.textContent = formatTime(currentOverlapTime);
        if (centralDuration) centralDuration.textContent = formatTime(overlapDuration);

        // Update Play/Pause Button
        if (centralPlayPauseBtn) {
            if (currentState === YT.PlayerState.PLAYING) {
                centralPlayPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                centralPlayPauseBtn.title = "Pause";
                startUiUpdateTimer(); // Keep UI updating while playing
            } else {
                centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                centralPlayPauseBtn.title = "Play";
                stopUiUpdateTimer(); // Stop frequent updates when paused/ended
                // Ensure seekbar reflects final position when paused/ended
                 if ((currentState === YT.PlayerState.PAUSED || currentState === YT.PlayerState.ENDED) && centralSeekBar && !centralSeekBar.matches(':active')) {
                     const seekBarValue = Math.max(0, Math.min(currentOverlapTime, overlapDuration));
                     centralSeekBar.value = seekBarValue;
                 }
            }
        }
    } catch (e) {
        console.warn("Error updating central controller UI:", e);
        stopUiUpdateTimer();
    }
}


function startUiUpdateTimer() {
    if (uiUpdateInterval) return;
    stopUiUpdateTimer();
    console.log("Starting UI update timer.");
    uiUpdateInterval = setInterval(() => {
        if (player1 && isSyncGloballyEnabled && !centralControlsContainer.classList.contains('controls-disabled') && typeof player1.getCurrentTime === 'function') {
             // Only call the update function, don't re-check conditions here
            updateCentralControllerUI(player1);
        } else {
            // Stop if conditions are no longer met
            stopUiUpdateTimer();
        }
    }, UI_UPDATE_INTERVAL_MS);
}

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
    if (loadBtn) {
        loadBtn.onclick = loadVideos;
        console.log("Load Videos listener attached.");
    } else {
        console.error("Load Videos button not found!");
    }

    // Toggle View / Cinema Mode
    if (toggleViewBtn && mainContainer) {
        toggleViewBtn.onclick = () => {
            const isEnteringCinemaMode = !mainContainer.classList.contains('controls-hidden');
            mainContainer.classList.toggle('controls-hidden'); // This class now means "Cinema Mode Active"
            document.body.classList.toggle('fullscreen-active'); // Used for body background/padding

            // --- UPDATED TEXT/TITLE ---
            if (isEnteringCinemaMode) {
                toggleViewBtn.innerHTML = '<i class="fas fa-compress"></i> Exit Cinema Mode'; // Icon for exiting
                toggleViewBtn.title = "Exit Cinema Mode";
                toggleViewBtn.setAttribute('aria-pressed', 'true');
                setSyncControlsVisibility(false); // *** Hide sync controls when entering cinema mode
                console.log("Cinema Mode Entered.");
            } else {
                toggleViewBtn.innerHTML = '<i class="fas fa-expand"></i> Cinema Mode'; // Icon for entering
                toggleViewBtn.title = "Enter Cinema Mode";
                toggleViewBtn.setAttribute('aria-pressed', 'false');
                // *** Show sync controls again IF sync is enabled
                setSyncControlsVisibility(isSyncGloballyEnabled && playersReady === 2);
                console.log("Cinema Mode Exited.");
            }
            window.dispatchEvent(new Event('resize')); // Helps redraw players, especially on exit
        };
        console.log("Toggle view (Cinema Mode) listener attached.");
    } else {
        console.warn("Toggle view button or main container not found.");
    }

    // Sync Toggle
    if (syncToggleCheckbox) {
        syncToggleCheckbox.onchange = handleSyncToggleChange;
        console.log("Sync toggle listener attached.");
    } else {
        console.warn("Sync toggle checkbox not found.");
    }

    // *** NEW: Apply Offset Button Listener ***
    if (applyOffsetBtn) {
        applyOffsetBtn.onclick = applyCustomOffset;
        console.log("Apply Offset listener attached.");
    } else {
         console.warn("Apply Offset button not found.");
    }


    // --- Central Controller Listeners ---
    if (centralPlayPauseBtn) {
        centralPlayPauseBtn.onclick = () => {
            if (!player1 || !player2 || !isSyncGloballyEnabled) return;
            try {
                const state = player1.getPlayerState();
                if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
                    console.log("Central Control: Pausing both players.");
                    player1.pauseVideo();
                    player2.pauseVideo();
                } else {
                     // Before playing, ensure seek is within current overlap
                    const currentTimeP1 = player1.getCurrentTime();
                    const seekTimeP1 = Math.max(overlapStartP1, Math.min(currentTimeP1, overlapEndP1));
                    // If current time was outside overlap, seek first
                    if (Math.abs(currentTimeP1 - seekTimeP1) > 0.1) {
                        const seekTimeP2 = seekTimeP1 + syncOffsetSeconds;
                        console.log(`Central Control Play: Seeking to overlap start before playing. P1=${seekTimeP1.toFixed(3)}, P2=${seekTimeP2.toFixed(3)}`)
                        player1.seekTo(seekTimeP1, true);
                        player2.seekTo(Math.max(0, seekTimeP2), true);
                        // Add slight delay before play after seek
                        setTimeout(() => {
                            if (player1 && player2 && isSyncGloballyEnabled) {
                                console.log("Central Control: Playing both players (after seek adjustment).");
                                player1.playVideo();
                                player2.playVideo();
                            }
                        }, 150);
                    } else {
                        console.log("Central Control: Playing both players.");
                        player1.playVideo();
                        player2.playVideo();
                    }
                }
            } catch (e) {
                console.error("Error handling central play/pause:", e);
            }
        };
        console.log("Central play/pause listener attached.");
    } else {
        console.warn("Central play/pause button not found.");
    }

    if (centralSeekBar) {
        let wasPlayingOnSeekStart = false;
         centralSeekBar.addEventListener('mousedown', () => {
             if (!player1 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
             try {
                 wasPlayingOnSeekStart = player1.getPlayerState() === YT.PlayerState.PLAYING;
                 if (wasPlayingOnSeekStart) {
                     player1.pauseVideo(); // Pause P1 temporarily during seek drag
                     // No need to pause P2 here, just P1 to stop its time advancing
                     stopUiUpdateTimer(); // Stop UI updates while dragging
                 }
             } catch(e) { console.warn("Error on seek mousedown:", e); }
         });

        centralSeekBar.addEventListener('input', () => {
            if (!player1 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
            // Only update the time display during drag, don't seek yet
            const seekOverlapTime = parseFloat(centralSeekBar.value);
            if (centralCurrentTime) {
                centralCurrentTime.textContent = formatTime(seekOverlapTime);
            }
        });

        centralSeekBar.addEventListener('change', () => {
            if (!player1 || !player2 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
            try {
                const seekOverlapTime = parseFloat(centralSeekBar.value);
                const seekTimeP1 = seekOverlapTime + overlapStartP1;
                // Clamp final P1 seek time strictly within the overlap
                const clampedSeekTimeP1 = Math.max(overlapStartP1, Math.min(seekTimeP1, overlapEndP1));
                const seekTimeP2 = clampedSeekTimeP1 + syncOffsetSeconds;

                console.log(`Central Control Seek: OverlapValue=${seekOverlapTime.toFixed(3)} -> Seeking P1 to ${clampedSeekTimeP1.toFixed(3)}s, P2 to ${seekTimeP2.toFixed(3)}s`);

                player1.seekTo(clampedSeekTimeP1, true);
                player2.seekTo(Math.max(0, seekTimeP2), true);

                 // If it was playing before seeking, resume playback after seek completes
                if (wasPlayingOnSeekStart) {
                    setTimeout(() => {
                        if (player1 && player2 && isSyncGloballyEnabled) {
                            player1.playVideo();
                            player2.playVideo(); // Explicitly play P2 as well
                             startUiUpdateTimer(); // Restart UI timer
                        }
                    }, 150); // Delay to allow seek to register
                } else {
                     // If paused, update UI immediately after seek change
                     // Recalculate final overlap time after clamping
                     const finalOverlapTime = clampedSeekTimeP1 - overlapStartP1;
                     if (centralCurrentTime) centralCurrentTime.textContent = formatTime(finalOverlapTime);
                     if (centralSeekBar) centralSeekBar.value = finalOverlapTime; // Ensure slider snaps to clamped value
                }
            } catch (e) {
                console.error("Error handling central seek:", e);
                 // If error occurs, try to restart UI timer if it was playing
                 if (wasPlayingOnSeekStart && player1 && player1.getPlayerState() === YT.PlayerState.PLAYING) {
                     startUiUpdateTimer();
                 }
            } finally {
                 wasPlayingOnSeekStart = false; // Reset flag
            }
        });
        console.log("Central seek bar listeners attached.");
    } else {
        console.warn("Central seek bar not found.");
    }

    if (centralSkipForwardBtn) {
        centralSkipForwardBtn.onclick = () => handleSkip(5);
        console.log("Central skip forward listener attached.");
    } else {
        console.warn("Central skip forward button not found.");
    }
    if (centralSkipBackwardBtn) {
        centralSkipBackwardBtn.onclick = () => handleSkip(-5);
        console.log("Central skip backward listener attached.");
    } else {
        console.warn("Central skip backward button not found.");
    }
}


// --- Handler for Sync Toggle Change (Handles Player Recreation & Offset) ---
function handleSyncToggleChange() {
    if (!syncToggleCheckbox || isRecreating) return; // Prevent action if already recreating

    const targetSyncStateEnabled = syncToggleCheckbox.checked;
    console.log("Sync toggle changed. Target state:", targetSyncStateEnabled ? "ENABLED" : "DISABLED");

    isSyncGloballyEnabled = targetSyncStateEnabled; // Update global var for status message logic NOW
    setSyncControlsVisibility(isSyncGloballyEnabled && playersReady === 2); // *** Update sync controls visibility

    if (!player1 || !player2 || playersReady < 2) {
        console.log("Sync toggle changed, but players not ready. Will apply state when ready.");
        setCentralControlsEnabled(false); // Ensure central controls are off
        updateSyncStatusMessage();
        return;
    }

    console.log("Initiating player recreation due to sync toggle change...");
    isRecreating = true;
    statusElement.textContent = "Reconfiguring players...";
    setCentralControlsEnabled(false); // Disable central controls during recreation
    setSyncControlsVisibility(false); // Hide sync controls during recreation
    stopDriftLogTimer(); // Stop timers
    stopUiUpdateTimer();

    try { // Capture state
        tempStartTimeP1 = player1.getCurrentTime();
        if (targetSyncStateEnabled) {
            // If enabling sync, calculate the offset based on current times BEFORE destroying
            const currentTimeP2 = player2.getCurrentTime();
            tempSyncOffset = currentTimeP2 - tempStartTimeP1;
            console.log(`Sync Enabling: Captured state & calculated NEW offset: P1 Time=${tempStartTimeP1.toFixed(3)}, Offset=${tempSyncOffset.toFixed(3)}`);
        } else {
            // If disabling sync, the offset becomes irrelevant for recreation
            tempSyncOffset = 0; // Will be ignored anyway, but set to 0 for clarity
             syncOffsetSeconds = 0; // Reset the main offset variable as well when disabling
             updateOffsetInputValue(); // Update input to show 0
             if(driftDisplay) driftDisplay.textContent = "N/A"; // Clear drift display
            console.log(`Sync Disabling: Captured state: P1 Time=${tempStartTimeP1.toFixed(3)}`);
        }
        // Pause players before destroying
        player1.pauseVideo();
        player2.pauseVideo();
    } catch (e) {
        console.warn("Error capturing state before recreation:", e);
        tempStartTimeP1 = 0;
        tempSyncOffset = 0;
    }

    const newControlsValue = targetSyncStateEnabled ? 0 : 1; // 0=Hidden YT Controls, 1=Shown YT Controls
    console.log(`Target native controls value: ${newControlsValue}`);

    // Use setTimeout to allow pause command to process before destroying
    setTimeout(() => {
        destroyPlayers(); // Destroy players
        isRecreating = true; // Ensure flag is still set
        playersReady = 0; // Reset ready count
        console.log("Recreating players now...");
        if (storedVideoId1 && storedVideoId2) {
            // Recreate with stored IDs and new controls value
            createPlayer('player1', storedVideoId1, newControlsValue);
            createPlayer('player2', storedVideoId2, newControlsValue);
             // onPlayerReady will handle the rest (seeking, enabling controls, updating UI etc.)
        } else {
            console.error("Cannot recreate players: Stored video IDs are missing.");
            statusElement.textContent = "Error: Cannot reconfigure players.";
            isRecreating = false; // Reset flag on error
            if (loadBtn) loadBtn.disabled = false;
        }
    }, 150); // Short delay
}


// --- Handler for Skip Buttons (Considers Overlap) ---
function handleSkip(secondsToSkip) {
    if (!player1 || !player2 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
    try {
        const currentTimeP1 = player1.getCurrentTime();
        const targetTimeP1 = currentTimeP1 + secondsToSkip;

        // Clamp the target P1 time within the valid overlap range
        const seekTimeP1 = Math.max(overlapStartP1, Math.min(targetTimeP1, overlapEndP1));

        // Calculate the corresponding P2 time using the current offset
        const seekTimeP2 = seekTimeP1 + syncOffsetSeconds;

        console.log(`Central Control Skip: ${secondsToSkip}s -> Clamped Seek P1 to ${seekTimeP1.toFixed(3)}s, P2 to ${seekTimeP2.toFixed(3)}s`);

        // Seek both players
        player1.seekTo(seekTimeP1, true);
        player2.seekTo(Math.max(0, seekTimeP2), true); // Ensure P2 doesn't go below 0

        // Update the UI immediately to reflect the skip
        const seekOverlapTime = seekTimeP1 - overlapStartP1;
        if (centralSeekBar) centralSeekBar.value = seekOverlapTime;
        if (centralCurrentTime) centralCurrentTime.textContent = formatTime(seekOverlapTime);

        // If paused, trigger a manual UI update
        if (player1.getPlayerState() !== YT.PlayerState.PLAYING) {
            // Use setTimeout to ensure the UI update happens after the seek likely registers
            setTimeout(() => updateCentralControllerUI(player1), 50);
        }
        // If playing, the regular UI timer will catch up.
    } catch (e) {
        console.error(`Error handling skip (${secondsToSkip}s):`, e);
    }
}

// --- Drift Monitoring Logic ---
function logDrift() {
    // Only calculate and display if sync is globally enabled and players are ready
    if (!isSyncGloballyEnabled || isRecreating || playersReady < 2 || !player1 || !player2 || typeof player1.getCurrentTime !== 'function' || typeof player2.getCurrentTime !== 'function') {
        if (driftDisplay && driftDisplay.textContent !== "N/A") {
             driftDisplay.textContent = "N/A"; // Clear display if conditions not met
        }
        return; // Don't proceed if sync off or players not ready
    }

    try {
        const time1 = player1.getCurrentTime();
        const time2 = player2.getCurrentTime();
        const actualOffset = time2 - time1;
        const drift = actualOffset - syncOffsetSeconds; // Drift is difference from TARGET offset

        // Log to console regardless
        console.log(`Drift Monitor | P1: ${time1.toFixed(3)}s | P2: ${time2.toFixed(3)}s | Actual Offset: ${actualOffset.toFixed(3)}s | Target Offset: ${syncOffsetSeconds.toFixed(3)}s | Drift: ${drift.toFixed(3)}s`);

        // Update the UI element if it exists
        if (driftDisplay) {
            driftDisplay.textContent = drift.toFixed(3) + "s";
        }

    } catch (e) {
        console.warn("Error during drift logging/updating:", e);
        if (driftDisplay) {
            driftDisplay.textContent = "Error"; // Show error in display
        }
    }
}


function startDriftLogTimer() {
    if (driftLogInterval) return; // Already running
    stopDriftLogTimer(); // Ensure any previous timer is stopped
    console.log(`Starting drift monitor log/update timer (Interval: ${DRIFT_LOG_INTERVAL_MS}ms)`);
    // Run immediately once
    logDrift();
    // Then run on interval
    driftLogInterval = setInterval(logDrift, DRIFT_LOG_INTERVAL_MS);
}

function stopDriftLogTimer() {
    if (driftLogInterval) {
        console.log("Stopping drift monitor log/update timer.");
        clearInterval(driftLogInterval);
        driftLogInterval = null;
        // Optionally clear drift display when timer stops? Maybe better to leave last value.
        // if (driftDisplay) driftDisplay.textContent = "N/A";
    }
}


// --- UI Interaction Logic ---
function updateSyncStatusMessage() {
    if (!statusElement) return;
    if (isRecreating) {
        statusElement.textContent = "Reconfiguring players...";
        return;
    }
    // Avoid overwriting loading/error messages until players are ready
    if (playersReady < 2 && (statusElement.textContent.includes("Loading") || statusElement.textContent.includes("Waiting") || statusElement.textContent.includes("Error"))) {
        return;
    }

    const currentSyncEnabledState = syncToggleCheckbox ? syncToggleCheckbox.checked : isSyncGloballyEnabled;

    if (currentSyncEnabledState) {
        let offsetMsg = "";
        // Show offset in status only if it's significantly non-zero
        if (playersReady === 2 && Math.abs(syncOffsetSeconds) > 0.01) {
            const sign = syncOffsetSeconds > 0 ? "+" : "";
            offsetMsg = ` (Offset: P2 ${sign}${syncOffsetSeconds.toFixed(2)}s)`;
        }

        const controlsActive = centralControlsContainer && !centralControlsContainer.classList.contains('controls-disabled');

        if (playersReady < 2) {
            statusElement.textContent = `Sync Enabled: Waiting for players...`;
        } else if (overlapDuration <= 0) {
            // Check players exist before saying no overlap
            statusElement.textContent = `Sync Enabled: No overlapping playtime detected.${offsetMsg}`;
        } else if (controlsActive) {
            statusElement.textContent = `Sync Enabled: Central controls active.${offsetMsg}`;
        } else {
             // Controls might be inactive briefly during init or if overlap became 0
            statusElement.textContent = `Sync Enabled: Ready.${offsetMsg}`;
        }
    } else {
        // Sync Disabled
        if (playersReady < 2) {
            statusElement.textContent = 'Sync Disabled: Waiting for players...';
        } else {
            statusElement.textContent = 'Sync Disabled: Use individual player controls. Enable sync to use central controls or set offset.';
        }
    }
}


// --- Initial Setup on DOM Load ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded. Setting up initial state and listeners.");
    if (loadBtn) {
        loadBtn.disabled = true; // Disabled until API loads
    }
    if (mainContainer) mainContainer.classList.remove('controls-hidden');
    document.body.classList.remove('fullscreen-active');
    if (toggleViewBtn) { // Set initial toggle button state for Cinema Mode
        toggleViewBtn.innerHTML = '<i class="fas fa-expand"></i> Cinema Mode';
        toggleViewBtn.title = "Enter Cinema Mode";
        toggleViewBtn.setAttribute('aria-pressed', 'false');
    }

    isSyncGloballyEnabled = syncToggleCheckbox ? syncToggleCheckbox.checked : true;
    syncOffsetSeconds = 0;
    overlapStartP1 = 0;
    overlapEndP1 = Infinity;
    overlapDuration = 0;

    setCentralControlsEnabled(false); // Initially disabled
    setSyncControlsVisibility(false); // Initially hidden

    setupButtonListeners();
    updateSyncStatusMessage(); // Set initial status message
});
console.log("Initial script execution finished. Waiting for DOMContentLoaded and YouTube API Ready...");