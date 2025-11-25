/**
 * This function is called by navbar.js *after* the ROOT data is fetched.
 * @param {Array} rootData - The array of items from the master sheet.
 */
function startApplication(rootData) {
    
    // This file no longer builds any HTML.
    // It just passes the initial data to the router,
    // which will now manage the application state.
    
    initializeRouter(rootData);
}