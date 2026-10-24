package io.github.augustosc_eu.tunarrlineup;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Turns what someone typed into the Lineup server's origin (scheme, host and
 * port only). This is the companion's address, never Tunarr's (D60): the app
 * opens it as a page and the page keeps calling only its own /api/tunarr/*.
 */
final class ServerAddress {
    /** The companion's default port, assumed when neither a scheme nor a port is typed. */
    static final int DEFAULT_PORT = 3000;

    private ServerAddress() {}

    /** @throws IllegalArgumentException with a message to show, when it isn't a usable address. */
    static String normalize(String input) {
        String text = input == null ? "" : input.trim();
        if (text.isEmpty()) throw new IllegalArgumentException("Type the Lineup server's address.");
        boolean bare = !text.contains("://");
        URI uri;
        try {
            uri = new URI(bare ? "http://" + text : text);
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("That isn't an address. Try something like http://192.168.1.50:3000");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) {
            throw new IllegalArgumentException("Use an http:// or https:// address.");
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) throw new IllegalArgumentException("The address needs a host name or IP address.");
        if (uri.getRawUserInfo() != null) throw new IllegalArgumentException("Leave the user name out; you'll be asked to sign in if the server needs it.");
        String path = uri.getRawPath();
        if ((path != null && !path.isEmpty() && !path.equals("/")) || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("Use just the server's address, without a path.");
        }
        int port = uri.getPort();
        if (port == -1 && bare) port = DEFAULT_PORT;
        int standard = scheme.equals("https") ? 443 : 80;
        String origin = scheme + "://" + host.toLowerCase(Locale.ROOT);
        return port == -1 || port == standard ? origin : origin + ":" + port;
    }

    /** Whether a URL belongs to the saved origin, so the window may show it. */
    static boolean isSameOrigin(String origin, String url) {
        try {
            return normalizeUrlOrigin(url).equals(origin);
        } catch (IllegalArgumentException | URISyntaxException error) {
            return false;
        }
    }

    private static String normalizeUrlOrigin(String url) throws URISyntaxException {
        URI uri = new URI(url);
        if (uri.getScheme() == null || uri.getHost() == null) throw new URISyntaxException(url, "not a web address");
        return normalize(uri.getScheme() + "://" + uri.getRawAuthority());
    }
}
