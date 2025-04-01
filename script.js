// Global variables for player instances
let player1 = null;
let player2 = null;
let playersReady = 0; // Counter for ready players
let isSyncing = false; // Flag to prevent event loops
const statusElement = document.getElementById('status');
const loadBtn = document.getElementById('loadVideosBtn');
const videoId1Input = document.getElementById('videoId1');
const videoId2Input = document.getElementById('videoId2');

// 1. This function creates an <iframe> (and YouTube player)
//    after the API code downloads. It's called automatically by the API.
window.onYouTubeIframeAPIReady = function() {
    statusElement.textContent = 'API Loaded. Enter Video IDs and click "Load Videos".';
    loadBtn.disabled = false;
    loadBtn.onclick = loadVideos; // Attach event listener here
};

function loadVideos() {
    const videoId1 = videoId1Input.value.trim();
    const videoId2 = videoId2Input.value.trim();

    if (!videoId1 || !videoId2) {
        statusElement.textContent = 'Please enter valid YouTube Video IDs for both players.';
        return;
    }

    statusElement.textContent = 'Loading videos...';
    loadBtn.disabled = true; // Disable button during load

    // Reset state
    playersReady = 0;
    destroyPlayers(); // Destroy existing players if any

    // Create Player 1
    player1 = new YT.Player('player1', {
        height: '360', // Will be overridden by CSS aspect-ratio
        width: '640',  // Will be overridden by CSS width: 100%
        videoId: videoId1,
        playerVars: {
            'playsinline': 1, // Important for mobile playback
            'enablejsapi': 1, // Enable JavaScript API
            // 'controls': 0 // Use 0 for fully custom controls, 1 for default YT controls
        },
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
        playerVars: {
            'playsinline': 1,
            'enablejsapi': 1,
            // 'controls': 0
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });
}

function destroyPlayers() {
    if (player1 && typeof player1.destroy === 'function') {
        player1.destroy();
        player1 = null;
    }
    if (player2 && typeof player2.destroy === 'function') {
        player2.destroy();
        player2 = null;
    }
    // Clear the placeholder divs in case of errors or reload
    document.getElementById('player1').innerHTML = '';
    document.getElementById('player2').innerHTML = '';

}

// 2. The API calls this function when the video player is ready.
function onPlayerReady(event) {
    playersReady++;
    if (playersReady === 2) {
        statusElement.textContent = 'Players Ready. Controls are synced.';
        loadBtn.disabled = false; // Re-enable button
        // You could potentially auto-play here if desired,
        // but user interaction is generally required by browsers.
        // syncTime(); // Initial time sync might be useful
    } else {
         statusElement.textContent = `Waiting for ${2 - playersReady} more player(s)...`;
    }
}

// 3. The API calls this function when the player's state changes.
function onPlayerStateChange(event) {
    if (isSyncing || playersReady < 2) {
        // If the change was triggered by our sync code or players aren't ready,
        // reset the flag and ignore the event to prevent loops.
        isSyncing = false;
        return;
    }

    const state = event.data;
    const sourcePlayer = event.target;
    const targetPlayer = (sourcePlayer === player1) ? player2 : player1;

    // console.log("State Change:", state, "Source:", (sourcePlayer === player1) ? "P1" : "P2");

    switch (state) {
        case YT.PlayerState.PLAYING:
            // When one starts playing, play the other and sync time
            isSyncing = true; // Set flag BEFORE triggering action on target
            const currentTime = sourcePlayer.getCurrentTime();
            targetPlayer.seekTo(currentTime, true); // Seek first
            targetPlayer.playVideo();              // Then play
             // console.log("Sync: Play", "Time:", currentTime);
            break;

        case YT.PlayerState.PAUSED:
            // When one pauses, pause the other and sync time
            isSyncing = true; // Set flag BEFORE triggering action on target
             // Pause slightly *after* getting time, otherwise currentTime might be slightly off
            targetPlayer.pauseVideo();
            // Ensure times are aligned on pause
            setTimeout(() => { // Small delay allows pause action to settle
                 const pausedTime = sourcePlayer.getCurrentTime();
                 targetPlayer.seekTo(pausedTime, true);
                 // console.log("Sync: Pause", "Time:", pausedTime);
            }, 100); // 100ms delay, adjust if needed
            break;

        case YT.PlayerState.BUFFERING:
            // Optional: Pause the other player while one is buffering to keep sync
            // isSyncing = true;
            // targetPlayer.pauseVideo();
            // console.log("Sync: Buffering Pause");
             // Note: This can sometimes feel jerky if buffering is frequent.
             // The PLAYING state's seekTo often handles buffer recovery adequately.
            break;

        case YT.PlayerState.ENDED:
            // Optional: Pause the other player when one ends
            isSyncing = true;
            targetPlayer.pauseVideo();
            // console.log("Sync: Ended Pause");
            break;

        // case YT.PlayerState.CUED:
            // console.log("Sync: Cued");
            // break; // Do nothing specific for cued usually
    }

    // Reset sync flag if it wasn't reset by the return statement (e.g., if no action taken)
    // Added safety, though the logic above should handle it.
    // setTimeout(() => { isSyncing = false; }, 50);
}

// Optional function to manually sync time if needed (e.g., on load)
function syncTime() {
    if (player1 && player2 && playersReady === 2) {
        const time1 = player1.getCurrentTime();
        // console.log("Manual Sync: Setting P2 time to P1 time:", time1);
        isSyncing = true; // Prevent immediate state change loop
        player2.seekTo(time1, true);
        // It's good practice to reset the flag after a short delay
        setTimeout(() => { isSyncing = false; }, 100);
    }
}

// Initial setup: Disable button until API is ready
loadBtn.disabled = true;