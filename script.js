// --- Global Variables & DOM References ---
const statusElement = document.getElementById('status');
const loadBtn = document.getElementById('loadVideosBtn');
const videoId1Input = document.getElementById('videoId1');
const videoId2Input = document.getElementById('videoId2');
const toggleViewBtn = document.getElementById('toggleViewBtn');
const mainContainer = document.querySelector('.main-container');
const bodyElement = document.body; // Reference to body for sync class

// Central Controls References
const centralControlsContainer = document.getElementById('centralControls');
const centralPlayPauseBtn = document.getElementById('centralPlayPauseBtn');
const centralSeekBar = document.getElementById('centralSeekBar');
const centralCurrentTime = document.getElementById('centralCurrentTime');
const centralDuration = document.getElementById('centralDuration');
const centralSkipBackwardBtn = document.getElementById('centralSkipBackwardBtn');
const centralSkipForwardBtn = document.getElementById('centralSkipForwardBtn');

// Per-Player and Bottom Sync Controls References
const playerSyncInfo1 = document.getElementById('playerSyncInfo1');
const offsetInput1 = document.getElementById('offsetInput1');
const offsetDesc1 = document.getElementById('offsetDesc1');
const driftValue1 = document.getElementById('driftValue1');

const playerSyncInfo2 = document.getElementById('playerSyncInfo2');
const offsetInput2 = document.getElementById('offsetInput2');
const offsetDesc2 = document.getElementById('offsetDesc2');
const driftValue2 = document.getElementById('driftValue2');

const offsetAdjustBtns = document.querySelectorAll('.offset-adjust');

const syncControlsBottom = document.getElementById('syncControlsBottom'); // Section is now always visible (in non-cinema)
const syncToggleCheckbox = document.getElementById('syncToggleCheckbox');
const updateOffsetBtn = document.getElementById('updateOffsetBtn');


// Player instances
let player1 = null;
let player2 = null;
let playersReady = 0;

// Sync State Variables
let isSyncGloballyEnabled = true;
let syncOffsetSeconds = 0;
let isUpdatingOffsetsInternally = false;

// Overlap Calculation State
let overlapStartP1 = 0;
let overlapEndP1 = Infinity;
let overlapDuration = 0;

// State Preservation During Recreate
let storedVideoId1 = '';
let storedVideoId2 = '';
let tempStartTimeP1 = 0;
let tempSyncOffset = 0;
let isRecreating = false;

// Drift Monitoring Variables
let driftLogInterval = null;
const DRIFT_LOG_INTERVAL_MS = 1000;

// Central Controller UI Update Timer
let uiUpdateInterval = null;
const UI_UPDATE_INTERVAL_MS = 250;

// --- Helper Functions ---
// (extractVideoId, formatTime, getPlayerStateName remain the same)
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
    // ... (Input validation remains the same) ...
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
    isSyncGloballyEnabled = true;
    syncOffsetSeconds = 0;
    overlapStartP1 = 0;
    overlapEndP1 = Infinity;
    overlapDuration = 0;
    if (syncToggleCheckbox) syncToggleCheckbox.checked = true;
    updateBodySyncClass(true); // Set body class (controls per-player info visibility)
    setCentralControlsEnabled(false);
    resetSyncUI(); // Reset fields

    storedVideoId1 = videoId1;
    storedVideoId2 = videoId2;
    const initialControls = syncToggleCheckbox.checked ? 0 : 1;
    console.log(`Initial load: Sync enabled = ${syncToggleCheckbox.checked}, Native controls = ${initialControls}`);
    createPlayer('player1', videoId1, initialControls);
    createPlayer('player2', videoId2, initialControls);
}

// (createPlayer, destroyPlayers remain the same)
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
    if (p1Element) p1Element.innerHTML = ''; // Clear placeholder
    const p2Element = document.getElementById('player2');
    if (p2Element) p2Element.innerHTML = '';
}


// --- onPlayerReady ---
function onPlayerReady(event) {
    playersReady++;
    const playerName = event.target === player1 ? "Player 1 (Left)" : "Player 2 (Right)";
    console.log(`${playerName} is Ready. Total ready: ${playersReady}`);

    if (playersReady === 2) {
        console.log("Both players ready.");
        if (loadBtn) loadBtn.disabled = false;
        // *** Update button state depends only on sync enabled, not players ready ***
        if (updateOffsetBtn) updateOffsetBtn.disabled = !isSyncGloballyEnabled;

        if (isRecreating) {
            // --- Post-Recreation Logic ---
            console.log(`Recreation complete. Restoring state: P1 time=${tempStartTimeP1.toFixed(2)}, Captured Offset=${tempSyncOffset.toFixed(2)}`);
            syncOffsetSeconds = tempSyncOffset;
            calculateOverlap();
            updateOffsetInputsFromGlobal(); // Update input fields + descriptions
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
                        isSyncGloballyEnabled = syncToggleCheckbox.checked;
                        updateBodySyncClass(isSyncGloballyEnabled); // Update body class
                        if (isSyncGloballyEnabled && overlapDuration > 0) {
                            setCentralControlsEnabled(true);
                            updateCentralControllerUI(player1, YT.PlayerState.PAUSED);
                            console.log("Central controls enabled post-recreation.");
                        } else {
                            setCentralControlsEnabled(false);
                            console.log(overlapDuration <= 0 ? "No overlap, keeping central controls disabled." : "Native controls enabled post-recreation.");
                        }
                        updateSyncStatusMessage();
                        startDriftLogTimer();
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
                updateBodySyncClass(isSyncGloballyEnabled);
                updateSyncStatusMessage();
                startDriftLogTimer();
                statusElement.textContent = "Error restoring state.";
            }
        } else {
            // --- Initial Load Logic ---
            console.log("Initial load complete.");
            isSyncGloballyEnabled = syncToggleCheckbox.checked;
            updateBodySyncClass(isSyncGloballyEnabled); // Set body class
            if (updateOffsetBtn) updateOffsetBtn.disabled = !isSyncGloballyEnabled; // Set button state

            if (isSyncGloballyEnabled) {
                try {
                    player1.pauseVideo();
                    player2.pauseVideo();
                    setTimeout(() => { // Delay to ensure pause registers
                        if (!player1 || !player2) return;
                        try {
                            const time1 = player1.getCurrentTime();
                            const time2 = player2.getCurrentTime();
                            syncOffsetSeconds = time2 - time1;
                            console.log(`Initial Offset (P2 - P1): ${syncOffsetSeconds.toFixed(3)}s`);
                            updateOffsetInputsFromGlobal();
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
                            updateBodySyncClass(false);
                            statusElement.textContent = "Error setting up sync.";
                            if(updateOffsetBtn) updateOffsetBtn.disabled = true; // Disable button on error
                        }
                    }, 150);
                } catch (e) {
                    console.error("Error during initial sync setup (outer):", e);
                    setCentralControlsEnabled(false);
                     updateBodySyncClass(false);
                     statusElement.textContent = "Error setting up sync.";
                     if(updateOffsetBtn) updateOffsetBtn.disabled = true;
                }
            } else {
                // Sync disabled initially
                setCentralControlsEnabled(false);
                try {
                    player1.pauseVideo();
                    player2.pauseVideo();
                } catch (e) {}
                 updateSyncStatusMessage();
                 startDriftLogTimer(); // Start timer even if sync off
                 statusElement.textContent = "Players Ready.";
                 resetSyncUI(); // Ensure per-player info is cleared
            }
        }
    } else if (playersReady < 2) {
        if (!isRecreating) {
            statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
        }
    }
}


// --- Calculate Overlap ---
// (No changes needed in calculateOverlap)
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
        overlapStartP1 = Math.max(0, -syncOffsetSeconds);
        const endP1_limit1 = duration1;
        const endP1_limit2 = duration2 - syncOffsetSeconds;
        overlapEndP1 = Math.min(endP1_limit1, endP1_limit2);
        overlapEndP1 = Math.max(overlapStartP1, overlapEndP1);
        overlapDuration = Math.max(0, overlapEndP1 - overlapStartP1);

        console.log(`Overlap Calculated: P1 Dur=${duration1.toFixed(2)}, P2 Dur=${duration2.toFixed(2)}, Offset(P2-P1)=${syncOffsetSeconds.toFixed(3)}`);
        console.log(`  -> Overlap in P1 Time: [${overlapStartP1.toFixed(3)}, ${overlapEndP1.toFixed(3)}] (Duration: ${overlapDuration.toFixed(3)}s)`);

        if (overlapDuration <= 0 && isSyncGloballyEnabled) {
            console.warn("No overlap detected between videos with current offset.");
             setCentralControlsEnabled(false);
        } else if (isSyncGloballyEnabled) {
            // Check if controls *should* be enabled now
            setCentralControlsEnabled(true);
        }
        updateCentralControllerUI(player1);

    } catch (e) {
        console.error("Error calculating overlap:", e);
        overlapStartP1 = 0;
        overlapEndP1 = Infinity;
        overlapDuration = 0;
        setCentralControlsEnabled(false);
    }
}

// --- onPlayerStateChange ---
// (No changes needed in onPlayerStateChange)
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
        if (newState === YT.PlayerState.PAUSED || newState === YT.PlayerState.ENDED) {
            logDrift();
        }
    } else if (!isSyncGloballyEnabled) {
        try {
            const sourceTime = changedPlayer.getCurrentTime();
            console.log(`State Change (Sync OFF) by ${changedPlayer === player1 ? 'P1':'P2'}: ${getPlayerStateName(newState)} @ ${sourceTime.toFixed(2)}s`);
        } catch (e) { /* ignore */ }
    } else if (isSyncGloballyEnabled && changedPlayer === player2) {
        console.log(`P2 State Changed (Sync ON, Ignored for UI): ${getPlayerStateName(newState)}`);
    }
}

// --- Sync Controls UI Logic ---

// Update body class (controls per-player info visibility)
function updateBodySyncClass(syncEnabled) {
    if (syncEnabled) {
        bodyElement.classList.add('sync-enabled');
        bodyElement.classList.remove('sync-disabled');
    } else {
        bodyElement.classList.remove('sync-enabled');
        bodyElement.classList.add('sync-disabled');
    }
    // Update button state matches sync state
    if (updateOffsetBtn) {
        updateOffsetBtn.disabled = !syncEnabled;
    }
}

// Reset sync UI elements
function resetSyncUI() {
    isUpdatingOffsetsInternally = true; // Prevent listeners firing during reset
    if(offsetInput1) offsetInput1.value = '';
    if(offsetInput2) offsetInput2.value = '';
    if(offsetDesc1) offsetDesc1.textContent = 'N/A';
    if(offsetDesc2) offsetDesc2.textContent = 'N/A';
    if(driftValue1) driftValue1.textContent = 'N/A';
    if(driftValue2) driftValue2.textContent = 'N/A';
    if(updateOffsetBtn) updateOffsetBtn.disabled = true; // Always disable on reset
    isUpdatingOffsetsInternally = false;
}

// Update offset description
function updateOffsetDescription(offsetVal) {
    let desc1 = "N/A";
    let desc2 = "N/A";
    const absOffset = Math.abs(offsetVal);

    if (isNaN(offsetVal)) {
         // Keep N/A
    } else if (absOffset < 0.001) {
        desc1 = "In Sync";
        desc2 = "In Sync";
    } else if (offsetVal > 0) { // P2 is later than P1
        desc1 = `${absOffset.toFixed(3)}s ahead`; // Left ahead
        desc2 = `${absOffset.toFixed(3)}s behind`; // Right behind
    } else { // P2 is earlier than P1
        desc1 = `${absOffset.toFixed(3)}s behind`; // Left behind
        desc2 = `${absOffset.toFixed(3)}s ahead`; // Right ahead
    }

    if (offsetDesc1) offsetDesc1.textContent = desc1;
    if (offsetDesc2) offsetDesc2.textContent = desc2;
}

// Update both offset input fields from the global offset
function updateOffsetInputsFromGlobal() {
    if (isUpdatingOffsetsInternally) return;
    isUpdatingOffsetsInternally = true;
    try {
        const offsetP2 = syncOffsetSeconds; // P2 - P1
        const offsetP1 = -syncOffsetSeconds; // P1 - P2

        if (offsetInput1) offsetInput1.value = offsetP1.toFixed(3);
        if (offsetInput2) offsetInput2.value = offsetP2.toFixed(3);
        updateOffsetDescription(syncOffsetSeconds);
    } catch (e) {
        console.error("Error updating offset inputs:", e);
    } finally {
        isUpdatingOffsetsInternally = false;
    }
}

// Handle input changes in either offset field
function handleOffsetInputChange(event) {
    if (isUpdatingOffsetsInternally || !isSyncGloballyEnabled) return;
    isUpdatingOffsetsInternally = true;
    try {
        const changedInput = event.target;
        const playerNum = changedInput.dataset.player;
        const newValueStr = changedInput.value;
        const newValue = parseFloat(newValueStr);

        if (isNaN(newValue)) {
            console.warn("Invalid offset input:", newValueStr);
             if (playerNum === '1') {
                 if(offsetDesc1) offsetDesc1.textContent = "Invalid";
                 if(offsetDesc2 && offsetInput2 && !isNaN(parseFloat(offsetInput2.value))) {
                     updateOffsetDescription(parseFloat(offsetInput2.value)); // Update P2 desc based on P2 input
                 } else {
                     if(offsetDesc2) offsetDesc2.textContent = "N/A";
                 }
            } else { // playerNum === '2'
                 if(offsetDesc2) offsetDesc2.textContent = "Invalid";
                 if(offsetDesc1 && offsetInput1 && !isNaN(parseFloat(offsetInput1.value))) {
                    updateOffsetDescription(-parseFloat(offsetInput1.value)); // Update P1 desc based on P1 input
                 } else {
                     if(offsetDesc1) offsetDesc1.textContent = "N/A";
                 }
            }
            return;
        }

        let newGlobalOffset;
        if (playerNum === '1') { // User changed Left input (P1 - P2)
            newGlobalOffset = -newValue; // Calculate P2 - P1
            if (offsetInput2) offsetInput2.value = newGlobalOffset.toFixed(3);
        } else { // User changed Right input (P2 - P1)
            newGlobalOffset = newValue;
            if (offsetInput1) offsetInput1.value = (-newGlobalOffset).toFixed(3);
        }
        updateOffsetDescription(newGlobalOffset); // Update descriptions
    } catch(e) {
        console.error("Error handling offset input change:", e);
    } finally {
        isUpdatingOffsetsInternally = false;
    }
}

// Handle +/- button clicks
function handleOffsetAdjustClick(event) {
     if (!isSyncGloballyEnabled) return;
     const button = event.target;
     const targetInputId = button.dataset.target;
     const delta = parseFloat(button.dataset.delta);
     const targetInput = document.getElementById(targetInputId);

     if (!targetInput || isNaN(delta)) return;

     try {
        const currentValue = parseFloat(targetInput.value);
        let newValue;
        if(isNaN(currentValue)) { // Treat invalid/empty as 0 before applying delta
            newValue = delta;
        } else {
            newValue = currentValue + delta;
        }
        targetInput.value = newValue.toFixed(3);
        targetInput.dispatchEvent(new Event('input', { bubbles: true })); // Trigger update
     } catch(e) {
        console.error("Error adjusting offset:", e);
     }
}

// Apply the offset when the Update button is clicked
function applyOffsetUpdate() {
    if (!offsetInput2 || !player1 || !player2 || !isSyncGloballyEnabled) {
        console.warn("Cannot apply offset: Input missing, players not ready, or sync disabled.");
        return;
    }
    const newOffsetStr = offsetInput2.value; // P2-P1 offset
    const newOffset = parseFloat(newOffsetStr);

    if (isNaN(newOffset)) {
        console.error("Invalid offset value in input field:", newOffsetStr);
        statusElement.textContent = "Error: Invalid offset value.";
        updateOffsetInputsFromGlobal(); // Revert inputs
        return;
    }

    console.log(`Applying updated offset (P2-P1): ${newOffset.toFixed(3)}s`);
    syncOffsetSeconds = newOffset;

    try {
        calculateOverlap();
        const currentTimeP1 = player1.getCurrentTime();
        const targetSeekP1 = Math.max(overlapStartP1, Math.min(currentTimeP1, overlapEndP1));
        const targetSeekP2 = targetSeekP1 + syncOffsetSeconds;
        console.log(`Seeking after applying offset: P1 to ${targetSeekP1.toFixed(3)}, P2 to ${targetSeekP2.toFixed(3)}`);

        const wasPlaying = player1.getPlayerState() === YT.PlayerState.PLAYING;
         if (wasPlaying) {
             player1.pauseVideo();
             player2.pauseVideo();
         }

        player1.seekTo(targetSeekP1, true);
        player2.seekTo(Math.max(0, targetSeekP2), true);

        if (wasPlaying) {
            setTimeout(() => {
                if (player1 && player2 && isSyncGloballyEnabled) {
                    player1.playVideo();
                    player2.playVideo();
                }
            }, 150);
        }

        updateOffsetInputsFromGlobal(); // Ensure inputs reflect applied offset
        setCentralControlsEnabled(isSyncGloballyEnabled && overlapDuration > 0);
        updateCentralControllerUI(player1);
        updateSyncStatusMessage();
        logDrift();
    } catch (e) {
        console.error("Error applying updated offset and seeking:", e);
        statusElement.textContent = "Error applying new offset.";
    }
}


// --- Central Controls Logic ---
// (setCentralControlsEnabled, updateCentralControllerUI, startUiUpdateTimer, stopUiUpdateTimer remain the same)
function setCentralControlsEnabled(enabled) {
    if (!centralControlsContainer) return;
    if (enabled && isSyncGloballyEnabled && overlapDuration > 0) {
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
        if (centralPlayPauseBtn) centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
        if (centralSeekBar) {
            centralSeekBar.value = 0;
            centralSeekBar.max = 100;
        }
        if (centralCurrentTime) centralCurrentTime.textContent = "0:00";
        if (centralDuration) centralDuration.textContent = "0:00";
    }
}

function updateCentralControllerUI(player, state) {
    if (!player || typeof player.getDuration !== 'function' || typeof player.getCurrentTime !== 'function' || !centralControlsContainer) return;
    if (!isSyncGloballyEnabled || overlapDuration <= 0 || overlapEndP1 === Infinity) {
        if (!centralControlsContainer.classList.contains('controls-disabled')) {
            console.log("Update UI skipped: Conditions not met (Sync off or no overlap).");
            setCentralControlsEnabled(false);
        }
        return;
    }
     if (centralControlsContainer.classList.contains('controls-disabled')) {
        console.log("Update UI called, enabling central controls.");
        setCentralControlsEnabled(true);
    }

    try {
        const currentTimeP1 = player.getCurrentTime();
        const currentState = state !== undefined ? state : player.getPlayerState();
        const clampedCurrentTimeP1 = Math.max(overlapStartP1, Math.min(currentTimeP1, overlapEndP1));
        const currentOverlapTime = clampedCurrentTimeP1 - overlapStartP1;

        if (centralSeekBar) {
            if (overlapDuration > 0 && Math.abs(centralSeekBar.max - overlapDuration) > 0.1) {
                centralSeekBar.max = overlapDuration;
                console.log(`Central Seekbar Max updated to: ${overlapDuration.toFixed(3)}`);
            }
            if (!centralSeekBar.matches(':active')) {
                 const seekBarValue = Math.max(0, Math.min(currentOverlapTime, overlapDuration));
                centralSeekBar.value = seekBarValue;
            }
        }
        if (centralCurrentTime) centralCurrentTime.textContent = formatTime(currentOverlapTime);
        if (centralDuration) centralDuration.textContent = formatTime(overlapDuration);
        if (centralPlayPauseBtn) {
            if (currentState === YT.PlayerState.PLAYING) {
                centralPlayPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                centralPlayPauseBtn.title = "Pause";
                startUiUpdateTimer();
            } else {
                centralPlayPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                centralPlayPauseBtn.title = "Play";
                stopUiUpdateTimer();
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
            updateCentralControllerUI(player1);
        } else {
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
// (setupButtonListeners structure remains the same, just ensure all listeners are added)
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
            mainContainer.classList.toggle('controls-hidden');
            bodyElement.classList.toggle('fullscreen-active');

            if (isEnteringCinemaMode) {
                toggleViewBtn.innerHTML = '<i class="fas fa-compress"></i> Exit Cinema Mode';
                toggleViewBtn.title = "Exit Cinema Mode";
                toggleViewBtn.setAttribute('aria-pressed', 'true');
                console.log("Cinema Mode Entered.");
            } else {
                toggleViewBtn.innerHTML = '<i class="fas fa-expand"></i> Cinema Mode';
                toggleViewBtn.title = "Enter Cinema Mode";
                toggleViewBtn.setAttribute('aria-pressed', 'false');
                console.log("Cinema Mode Exited.");
            }
            window.dispatchEvent(new Event('resize'));
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

    // Update Offset Button
    if (updateOffsetBtn) {
        updateOffsetBtn.onclick = applyOffsetUpdate;
        console.log("Update Offset listener attached.");
    } else {
         console.warn("Update Offset button not found.");
    }

    // Offset Input Listeners
    if (offsetInput1) {
        offsetInput1.addEventListener('input', handleOffsetInputChange);
        console.log("Offset Input 1 listener attached.");
    } else {
         console.warn("Offset Input 1 not found.");
    }
     if (offsetInput2) {
        offsetInput2.addEventListener('input', handleOffsetInputChange);
        console.log("Offset Input 2 listener attached.");
    } else {
         console.warn("Offset Input 2 not found.");
    }

    // Offset Adjust Button Listeners
    offsetAdjustBtns.forEach(button => {
        button.addEventListener('click', handleOffsetAdjustClick);
    });
    console.log(`Offset Adjust button listeners attached (${offsetAdjustBtns.length}).`);


    // Central Controller Listeners
    // (Play/Pause, Seek Bar, Skip buttons listeners remain the same)
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
                     const currentTimeP1 = player1.getCurrentTime();
                     const seekTimeP1 = Math.max(overlapStartP1, Math.min(currentTimeP1, overlapEndP1));
                     if (Math.abs(currentTimeP1 - seekTimeP1) > 0.1 && overlapDuration > 0) {
                         const seekTimeP2 = seekTimeP1 + syncOffsetSeconds;
                         console.log(`Central Control Play: Seeking to overlap start/end before playing. P1=${seekTimeP1.toFixed(3)}, P2=${seekTimeP2.toFixed(3)}`)
                         player1.seekTo(seekTimeP1, true);
                         player2.seekTo(Math.max(0, seekTimeP2), true);
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
                      player1.pauseVideo();
                      stopUiUpdateTimer();
                  }
              } catch(e) { console.warn("Error on seek mousedown:", e); }
          });

         centralSeekBar.addEventListener('input', () => {
             if (!player1 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
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
                 const clampedSeekTimeP1 = Math.max(overlapStartP1, Math.min(seekTimeP1, overlapEndP1));
                 const seekTimeP2 = clampedSeekTimeP1 + syncOffsetSeconds;

                 console.log(`Central Control Seek: OverlapValue=${seekOverlapTime.toFixed(3)} -> Seeking P1 to ${clampedSeekTimeP1.toFixed(3)}s, P2 to ${seekTimeP2.toFixed(3)}s`);

                 player1.seekTo(clampedSeekTimeP1, true);
                 player2.seekTo(Math.max(0, seekTimeP2), true);

                 if (wasPlayingOnSeekStart) {
                     setTimeout(() => {
                         if (player1 && player2 && isSyncGloballyEnabled) {
                             player1.playVideo();
                             player2.playVideo();
                              startUiUpdateTimer();
                         }
                     }, 150);
                 } else {
                      const finalOverlapTime = clampedSeekTimeP1 - overlapStartP1;
                      if (centralCurrentTime) centralCurrentTime.textContent = formatTime(finalOverlapTime);
                      if (centralSeekBar) centralSeekBar.value = finalOverlapTime;
                 }
             } catch (e) {
                 console.error("Error handling central seek:", e);
                  if (wasPlayingOnSeekStart && player1 && player1.getPlayerState() === YT.PlayerState.PLAYING) {
                      startUiUpdateTimer();
                  }
             } finally {
                  wasPlayingOnSeekStart = false;
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


// --- Handler for Sync Toggle Change ---
function handleSyncToggleChange() {
    if (!syncToggleCheckbox || isRecreating) return;

    const targetSyncStateEnabled = syncToggleCheckbox.checked;
    console.log("Sync toggle changed. Target state:", targetSyncStateEnabled ? "ENABLED" : "DISABLED");

    isSyncGloballyEnabled = targetSyncStateEnabled;
    updateBodySyncClass(isSyncGloballyEnabled); // Update body class (controls per-player UI)
    if(updateOffsetBtn) updateOffsetBtn.disabled = !targetSyncStateEnabled; // Enable/disable Update button

    if (!player1 || !player2 || playersReady < 2) {
        console.log("Sync toggle changed, but players not ready. State will be applied when ready.");
        setCentralControlsEnabled(false);
        if (!targetSyncStateEnabled) {
            resetSyncUI(); // Reset fields if disabling before ready
        }
        updateSyncStatusMessage();
        return;
    }

    console.log("Initiating player recreation due to sync toggle change...");
    isRecreating = true;
    statusElement.textContent = "Reconfiguring players...";
    setCentralControlsEnabled(false); // Disable central controls during recreation
    // Per-player sync UI visibility handled by body class change + CSS
    stopDriftLogTimer();
    stopUiUpdateTimer();

    try {
        tempStartTimeP1 = player1.getCurrentTime();
        if (targetSyncStateEnabled) {
            // Calculate offset if enabling
            const currentTimeP2 = player2.getCurrentTime();
            tempSyncOffset = currentTimeP2 - tempStartTimeP1;
            console.log(`Sync Enabling: Captured state & calculated NEW offset: P1 Time=${tempStartTimeP1.toFixed(3)}, Offset=${tempSyncOffset.toFixed(3)}`);
        } else {
            // Reset offset if disabling
            tempSyncOffset = 0;
            syncOffsetSeconds = 0;
            resetSyncUI(); // Clear offset/drift fields immediately
            console.log(`Sync Disabling: Captured state: P1 Time=${tempStartTimeP1.toFixed(3)}`);
        }
        player1.pauseVideo();
        player2.pauseVideo();
    } catch (e) {
        console.warn("Error capturing state before recreation:", e);
        tempStartTimeP1 = 0;
        tempSyncOffset = 0;
    }

    const newControlsValue = targetSyncStateEnabled ? 0 : 1;
    console.log(`Target native controls value: ${newControlsValue}`);

    setTimeout(() => {
        destroyPlayers();
        isRecreating = true;
        playersReady = 0;
        console.log("Recreating players now...");
        if (storedVideoId1 && storedVideoId2) {
            createPlayer('player1', storedVideoId1, newControlsValue);
            createPlayer('player2', storedVideoId2, newControlsValue);
        } else {
            console.error("Cannot recreate players: Stored video IDs are missing.");
            statusElement.textContent = "Error: Cannot reconfigure players.";
            isRecreating = false;
            if (loadBtn) loadBtn.disabled = false;
            updateBodySyncClass(isSyncGloballyEnabled); // Restore body class on error
            if(updateOffsetBtn) updateOffsetBtn.disabled = !isSyncGloballyEnabled; // Ensure button state correct on error
        }
    }, 150);
}


// --- Handler for Skip Buttons ---
// (No changes needed in handleSkip)
function handleSkip(secondsToSkip) {
    if (!player1 || !player2 || !isSyncGloballyEnabled || overlapDuration <= 0) return;
    try {
        const currentTimeP1 = player1.getCurrentTime();
        const targetTimeP1 = currentTimeP1 + secondsToSkip;
        const seekTimeP1 = Math.max(overlapStartP1, Math.min(targetTimeP1, overlapEndP1));
        const seekTimeP2 = seekTimeP1 + syncOffsetSeconds;

        console.log(`Central Control Skip: ${secondsToSkip}s -> Clamped Seek P1 to ${seekTimeP1.toFixed(3)}s, P2 to ${seekTimeP2.toFixed(3)}s`);

        player1.seekTo(seekTimeP1, true);
        player2.seekTo(Math.max(0, seekTimeP2), true);

        const seekOverlapTime = seekTimeP1 - overlapStartP1;
        if (centralSeekBar) centralSeekBar.value = seekOverlapTime;
        if (centralCurrentTime) centralCurrentTime.textContent = formatTime(seekOverlapTime);

        if (player1.getPlayerState() !== YT.PlayerState.PLAYING) {
            setTimeout(() => updateCentralControllerUI(player1), 50);
        }
    } catch (e) {
        console.error(`Error handling skip (${secondsToSkip}s):`, e);
    }
}

// --- Drift Monitoring Logic ---
// (No changes needed in logDrift, start/stopDriftLogTimer)
function logDrift() {
    let driftText = "N/A";
    if (isSyncGloballyEnabled && !isRecreating && playersReady === 2 && player1 && player2 && typeof player1.getCurrentTime === 'function' && typeof player2.getCurrentTime === 'function') {
        try {
            const time1 = player1.getCurrentTime();
            const time2 = player2.getCurrentTime();
            const actualOffset = time2 - time1;
            const drift = actualOffset - syncOffsetSeconds;
            console.log(`Drift Monitor | P1: ${time1.toFixed(3)}s | P2: ${time2.toFixed(3)}s | Actual Offset: ${actualOffset.toFixed(3)}s | Target Offset: ${syncOffsetSeconds.toFixed(3)}s | Drift: ${drift.toFixed(3)}s`);
            driftText = drift.toFixed(3) + "s";
        } catch (e) {
            console.warn("Error during drift logging/updating:", e);
            driftText = "Error";
        }
    }
    if (driftValue1) driftValue1.textContent = driftText;
    if (driftValue2) driftValue2.textContent = driftText;
}


function startDriftLogTimer() {
    if (driftLogInterval) return;
    stopDriftLogTimer();
    console.log(`Starting drift monitor log/update timer (Interval: ${DRIFT_LOG_INTERVAL_MS}ms)`);
    logDrift();
    driftLogInterval = setInterval(logDrift, DRIFT_LOG_INTERVAL_MS);
}

function stopDriftLogTimer() {
    if (driftLogInterval) {
        console.log("Stopping drift monitor log/update timer.");
        clearInterval(driftLogInterval);
        driftLogInterval = null;
    }
}


// --- UI Interaction Logic ---
// (updateSyncStatusMessage remains the same)
function updateSyncStatusMessage() {
    if (!statusElement) return;
    if (isRecreating) {
        statusElement.textContent = "Reconfiguring players...";
        return;
    }
    if (playersReady < 2 && (statusElement.textContent.includes("Loading") || statusElement.textContent.includes("Waiting") || statusElement.textContent.includes("Error"))) {
        return;
    }
    const currentSyncEnabledState = syncToggleCheckbox ? syncToggleCheckbox.checked : isSyncGloballyEnabled;
    if (currentSyncEnabledState) {
        const controlsActive = centralControlsContainer && !centralControlsContainer.classList.contains('controls-disabled');
        if (playersReady < 2) {
            statusElement.textContent = `Sync Enabled: Waiting for players...`;
        } else if (overlapDuration <= 0) {
            statusElement.textContent = `Sync Enabled: No overlapping playtime detected.`;
        } else if (controlsActive) {
            statusElement.textContent = `Sync Enabled: Central controls active.`;
        } else {
            statusElement.textContent = `Sync Enabled: Ready.`;
        }
    } else {
        if (playersReady < 2) {
            statusElement.textContent = 'Sync Disabled: Waiting for players...';
        } else {
            statusElement.textContent = 'Sync Disabled: Use individual player controls.';
        }
    }
}


// --- Initial Setup on DOM Load ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded. Setting up initial state and listeners.");
    if (loadBtn) loadBtn.disabled = true;
    if (mainContainer) mainContainer.classList.remove('controls-hidden');
    bodyElement.classList.remove('fullscreen-active');
    if (toggleViewBtn) {
        toggleViewBtn.innerHTML = '<i class="fas fa-expand"></i> Cinema Mode';
        toggleViewBtn.title = "Enter Cinema Mode";
        toggleViewBtn.setAttribute('aria-pressed', 'false');
    }

    isSyncGloballyEnabled = syncToggleCheckbox ? syncToggleCheckbox.checked : true;
    updateBodySyncClass(isSyncGloballyEnabled); // Set initial body class
    syncOffsetSeconds = 0;
    overlapStartP1 = 0;
    overlapEndP1 = Infinity;
    overlapDuration = 0;

    setCentralControlsEnabled(false);
    resetSyncUI(); // Set sync fields to default

    setupButtonListeners();
    updateSyncStatusMessage();
});
console.log("Initial script execution finished. Waiting for DOMContentLoaded and YouTube API Ready...");