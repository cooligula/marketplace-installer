// Ensure the VS Code API is available in the webview context
(function () {
    const vscode = acquireVsCodeApi();

    // Get references to HTML elements
    const searchInput = document.getElementById('search-input');
    const searchButton = document.getElementById('search-button');
    const resultsContainer = document.getElementById('results-container');
    const infoMessage = document.getElementById('info-message');

    /**
     * Sends a search message to the extension.
     */
    function performSearch() {
        const query = searchInput.value.trim();
        if (query) {
            console.log('Webview: Search button clicked. Sending "search" message to extension.', { query }); // Debugging
            // Send message to extension host
            vscode.postMessage({ type: 'search', value: query });
        } else {
            console.log('Webview: Search input is empty.'); // Debugging
            resultsContainer.innerHTML = '<p id="info-message">Please enter a search term.</p>';
        }
    }

    // Add event listeners for search input and button
    searchButton.addEventListener('click', performSearch);
    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            performSearch();
        }
    });

    // Handle messages received from the extension host
    window.addEventListener('message', event => {
        const message = event.data; // The JSON data sent from the extension
        console.log('Webview: Received message from extension:', message); // Debugging

        switch (message.type) {
            case 'setLoading':
                resultsContainer.innerHTML = '<p>Loading...</p>';
                break;
            case 'showResults':
                renderResults(message.value);
                break;
            case 'showError':
                resultsContainer.innerHTML = `<p class="error">${message.value}</p>`;
                break;
            case 'showInfo':
                resultsContainer.innerHTML = `<p id="info-message">${message.message}</p>`;
                break;
        }
    });

    /**
     * Renders the search results (list of extensions) in the webview.
     * @param {Array<Object>} extensions An array of extension objects.
     */
    function renderResults(extensions) {
        if (!extensions || extensions.length === 0) {
            resultsContainer.innerHTML = '<p>No extensions found.</p>';
            return;
        }

        resultsContainer.innerHTML = ''; // Clear previous results
        const list = document.createElement('ul');

        extensions.forEach(ext => {
            const li = document.createElement('li');
            li.className = 'extension-item';

            const icon = document.createElement('img');
            icon.className = 'extension-icon';
            // Provide a fallback placeholder image if iconUrl is empty or fails to load
            icon.src = ext.iconUrl || 'https://placehold.co/48x48/cccccc/000000?text=No+Icon';
            icon.onerror = function() {
                this.onerror=null; // Prevent infinite loop if fallback also fails
                this.src='https://placehold.co/48x48/cccccc/000000?text=Error'; // Show error placeholder
            };


            const details = document.createElement('div');
            details.className = 'extension-details';

            const name = document.createElement('h3');
            name.textContent = ext.displayName;

            const publisher = document.createElement('p');
            publisher.className = 'publisher';
            publisher.textContent = ext.publisherDisplayName;

            const description = document.createElement('p');
            description.className = 'description';
            // Limit description to 2 lines and add ellipsis if longer
            const maxLines = 2;
            const lineHeight = 1.3; // Based on CSS line-height for .description
            description.style.maxHeight = `${maxLines * lineHeight}em`;
            description.style.overflow = 'hidden';
            description.style.textOverflow = 'ellipsis';
            description.style.display = '-webkit-box';
            description.style.webkitLineClamp = maxLines;
            description.style.webkitBoxOrient = 'vertical';
            description.textContent = ext.shortDescription;


            const installButton = document.createElement('button');
            installButton.textContent = 'Install';
            installButton.className = 'install-button';
            installButton.addEventListener('click', () => {
                console.log('Webview: Install button clicked. Sending "install" message for:', ext.extensionId); // Debugging
                vscode.postMessage({ type: 'install', value: ext.extensionId });
            });
            
            details.appendChild(name);
            details.appendChild(publisher);
            details.appendChild(description);

            li.appendChild(icon);
            li.appendChild(details);
            li.appendChild(installButton);
            list.appendChild(li);
        });

        resultsContainer.appendChild(list);
    }
})();
