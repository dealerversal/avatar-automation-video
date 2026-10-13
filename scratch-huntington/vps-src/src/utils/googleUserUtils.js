import fs from 'fs';
import path from 'path';

/**
 * Robustly inspects Chrome/Chromium profile directory to extract
 * authenticated Google user details (name, email, avatar).
 * Returns { name, email, avatar } or null if not found.
 */
export function extractGoogleUserFromProfile(profileDir) {
    if (!profileDir || !fs.existsSync(profileDir)) return null;

    try {
        const candidateFiles = [
            path.join(profileDir, 'Default', 'Preferences'),
            path.join(profileDir, 'Preferences'),
            path.join(profileDir, 'Local State'),
            path.join(profileDir, 'storageState.json'),
            path.join(profileDir, 'cookies.json'),
        ];

        // Also look 1-level deep in subdirectories
        try {
            const entries = fs.readdirSync(profileDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    candidateFiles.push(path.join(profileDir, entry.name, 'Preferences'));
                }
            }
        } catch (_) {}

        for (const filePath of candidateFiles) {
            if (!fs.existsSync(filePath)) continue;
            try {
                const raw = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(raw);

                // 1. Check Chrome "account_info" array (Standard Chrome format in Preferences)
                if (Array.isArray(data.account_info) && data.account_info.length > 0) {
                    for (const acc of data.account_info) {
                        const email = acc.email || acc.user_name || acc.raw_email;
                        const name = acc.full_name || acc.given_name || acc.name;
                        if (email && email.includes('@')) {
                            return {
                                name: name || email.split('@')[0],
                                email,
                                avatar: acc.picture_url || null,
                            };
                        }
                    }
                }

                // 2. Check Chrome "profile.info_cache" (in Local State)
                const infoCache = data.profile?.info_cache;
                if (infoCache && typeof infoCache === 'object') {
                    for (const key of Object.keys(infoCache)) {
                        const prof = infoCache[key];
                        const email = prof.user_name || prof.email;
                        const name = prof.name || prof.gaia_name || prof.gaia_given_name;
                        if (email && email.includes('@')) {
                            return {
                                name: name || email.split('@')[0],
                                email,
                                avatar: prof.picture_url || null,
                            };
                        }
                    }
                }

                // 3. Check "signin.signed_in_accounts"
                const signedInAccounts = data.signin?.signed_in_accounts;
                if (signedInAccounts && typeof signedInAccounts === 'object') {
                    for (const key of Object.keys(signedInAccounts)) {
                        const acc = signedInAccounts[key];
                        const email = acc.email;
                        const name = acc.name || acc.full_name;
                        if (email && email.includes('@')) {
                            return {
                                name: name || email.split('@')[0],
                                email,
                                avatar: acc.picture_url || null,
                            };
                        }
                    }
                }

                // 4. Check "google.services.signin"
                const googleSignin = data.google?.services?.signin;
                if (googleSignin && googleSignin.user_email) {
                    return {
                        name: googleSignin.display_name || googleSignin.user_email.split('@')[0],
                        email: googleSignin.user_email,
                        avatar: null,
                    };
                }

                // 5. Check storageState.json origins
                if (Array.isArray(data.origins)) {
                    for (const origin of data.origins) {
                        if (Array.isArray(origin.localStorage)) {
                            for (const item of origin.localStorage) {
                                if (item.value && item.value.includes('@')) {
                                    try {
                                        const parsedVal = JSON.parse(item.value);
                                        if (parsedVal.email && parsedVal.email.includes('@')) {
                                            return {
                                                name: parsedVal.name || parsedVal.displayName || parsedVal.email.split('@')[0],
                                                email: parsedVal.email,
                                                avatar: parsedVal.picture || parsedVal.avatar || null,
                                            };
                                        }
                                    } catch (_) {}
                                }
                            }
                        }
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}

    return null;
}
