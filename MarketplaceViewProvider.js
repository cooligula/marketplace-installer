const vscode = require('vscode');
const axios = require('axios');
const { installExtension } = require('./extension'); 

class MarketplaceViewProvider {
    /**
     * @param {vscode.Uri} extensionUri The URI of the extension's root directory.
     * @param {Promise<string>} installerCmdPromise A promise that resolves with the path to the vsix-to-vscodium executable.
     * @param {function(string, string): Promise<void>} installExtensionFunction The installExtension function from extension.js.
     */
    constructor(extensionUri, installerCmdPromise, installExtensionFunction) {
        this._extensionUri = extensionUri;
        this._installerCmdPromise = installerCmdPromise;
        this._installExtension = installExtensionFunction; // Store the passed function
        this._view = null; // Reference to the webview panel
        this._disposables = []; // To manage event listeners
    }

    /**
     * Resolves a webview view. This is called by VS Code when the view is opened.
     * @param {vscode.WebviewView} webviewView
     * @param {vscode.WebviewViewResolveContext} context
     * @param {vscode.CancellationToken} _token
     */
    resolveWebviewView(webviewView, context, _token) {
        this._view = webviewView;

        // Set options for the webview
        webviewView.webview.options = {
            enableScripts: true, // Allow JavaScript in the webview
            // Restrict webview to only load resources from the extension's media directory
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
        };

        // Set the HTML content for the webview
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages received from the webview (e.g., search queries, install requests)
        webviewView.webview.onDidReceiveMessage(
            async message => {
                console.log('MarketplaceViewProvider: Received message from webview:', message); // Debugging
                switch (message.type) {
                    case 'search':
                        this.searchMarketplace(message.value);
                        break;
                    case 'install':
                        // Await the installer command path before calling installExtension
                        const installerCmd = await this._installerCmdPromise;
                        if (!installerCmd) {
                            vscode.window.showErrorMessage('Installer tool is not ready. Please wait for setup to complete.');
                            return;
                        }
                        // Use the function passed in the constructor
                        this._installExtension(message.value, installerCmd);
                        break;
                }
            },
            undefined,
            this._disposables // Add the listener to disposables for proper cleanup
        );
    }

    /**
     * Performs a search on the VS Code Marketplace API.
     * @param {string} query The search term.
     */
    async searchMarketplace(query) {
        if (!this._view) {
            console.error('MarketplaceViewProvider: Webview view is not initialized.');
            return;
        }
        if (!query) {
            this._view.webview.postMessage({ type: 'showInfo', message: 'Please enter a search term.' });
            return;
        }

        console.log(`MarketplaceViewProvider: Searching marketplace for: "${query}"`); // Debugging
        this._view.webview.postMessage({ type: 'setLoading' }); // Inform webview to show loading state

        try {
            const response = await axios.post('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
                filters: [{
                    criteria: [{
                        filterType: 10, // Keeping filterType at 10 (Search Text)
                        value: query
                    }],
                    pageNumber: 1, // Added pagination: Request the first page
                    pageSize: 50   // Added pagination: Request 50 results per page
                }],
                flags: 71 // Reverted flags to 71 for a more stable set of data
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json;api-version=6.0-preview.1', // Keeping updated API version
                    'User-Agent': 'VSCode Marketplace' // Mimic VS Code's user agent
                }
            });

            const results = response.data.results[0].extensions;
            console.log(`MarketplaceViewProvider: Found ${results.length} extensions.`); // Debugging

            // Get currently installed extensions to check against search results
            const installedExtensions = vscode.extensions.all.map(ext => ext.id.toLowerCase());

            // Map results to a simpler format for the webview and add installation status
            const formattedExtensions = results.map(ext => ({
                displayName: ext.displayName,
                publisherDisplayName: ext.publisher.displayName,
                shortDescription: ext.shortDescription,
                extensionId: `${ext.publisher.publisherName}.${ext.extensionName}`, // Full ID for installation
                iconUrl: ext.versions[0]?.files?.find(f => f.assetType === 'Microsoft.VisualStudio.Services.Icons.Default')?.source || '', // Get default icon
                isInstalled: installedExtensions.includes(`${ext.publisher.publisherName}.${ext.extensionName}`.toLowerCase()) // Check if installed
            }));

            this._view.webview.postMessage({ type: 'showResults', value: formattedExtensions });

        } catch (error) {
            console.error('MarketplaceViewProvider: Marketplace search failed:', error); // Debugging
            let errorMessage = 'Search failed. Please check your internet connection or try a different search term.';
            if (axios.isAxiosError(error)) {
                if (error.response) {
                    if (error.response.status === 404) {
                        errorMessage = 'Marketplace API endpoint not found or changed. This extension may need an update.';
                    } else if (error.response.status === 400) {
                        errorMessage = 'Invalid search request. The marketplace API might have changed its expected parameters.';
                    } else if (error.response.status === 500) {
                        errorMessage = 'Internal server error from Marketplace API. Please try again later.';
                    }
                } else if (error.request) {
                    errorMessage = 'Network error during search. Check your internet connection.';
                }
            }
            vscode.window.showErrorMessage(`Marketplace search failed: ${errorMessage}`);
            this._view.webview.postMessage({ type: 'showError', value: errorMessage });
        }
    }

    /**
     * Generates the HTML content for the webview.
     * @param {vscode.Webview} webview
     * @returns {string} The HTML string.
     */
    _getHtmlForWebview(webview) {
        // Get the URI for the webview's JavaScript and CSS files
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css'));

        // Use a nonce to allow only specific scripts to run for CSP
        const nonce = this._getNonce();

        console.log('MarketplaceViewProvider: Generated scriptUri:', scriptUri.toString()); // Debugging
        console.log('MarketplaceViewProvider: Generated stylesUri:', stylesUri.toString()); // Debugging

        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src https: data:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${stylesUri}" rel="stylesheet">
				<title>Marketplace Search</title>
			</head>
			<body>
                <div class="search-container">
				    <input type="text" id="search-input" placeholder="Search extensions..." aria-label="Search extensions"/>
                    <button id="search-button">Search</button>
                </div>

                <div id="results-container">
                    <p id="info-message">Enter a search term to find extensions.</p>
                </div>

				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
    }

    /**
     * Generates a random string for Content Security Policy (CSP) nonce.
     * @returns {string} A random string.
     */
    _getNonce() {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /**
     * Disposes of any resources held by the provider.
     */
    dispose() {
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}

module.exports = {
    MarketplaceViewProvider
};
