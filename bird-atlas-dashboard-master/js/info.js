// --- js/info.js ---

const InfoManager = (function ($) {
    
    // Cache the selector
    const $landingMessage = $('#landing-message');

    return {
        // Function to show the message (used on homepage)
        showLandingMessage: function () {
            $landingMessage.show();
        },

        // Function to hide the message (used when navigating)
        hideLandingMessage: function () {
            $landingMessage.hide();
        }
    };

})(jQuery);