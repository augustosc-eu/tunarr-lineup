package io.github.augustosc_eu.tunarrlineup;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public class ServerAddressTest {
    @Test
    public void bareAddressesGetHttpAndTheCompanionPort() {
        assertEquals("http://192.168.1.50:3000", ServerAddress.normalize(" 192.168.1.50 "));
        assertEquals("http://nas.local:3000", ServerAddress.normalize("NAS.local"));
        assertEquals("http://nas.local:8080", ServerAddress.normalize("nas.local:8080"));
        assertEquals("http://[fd00::5]:3000", ServerAddress.normalize("[fd00::5]"));
    }

    @Test
    public void typedSchemesKeepTheirDefaultPorts() {
        assertEquals("https://lineup.example.com", ServerAddress.normalize("https://lineup.example.com/"));
        assertEquals("https://lineup.example.com", ServerAddress.normalize("HTTPS://lineup.example.com:443"));
        assertEquals("http://tv.home", ServerAddress.normalize("http://tv.home:80"));
        assertEquals("http://10.0.0.2:3000", ServerAddress.normalize("http://10.0.0.2:3000"));
    }

    @Test
    public void refusesAnythingButAPlainServerAddress() {
        for (String bad : new String[] {"", "   ", "ftp://nas", "file:///etc/hosts", "javascript:alert(1)", "http://user:pw@nas:3000",
                "http://nas:3000/api/tunarr", "http://nas:3000?x=1", "http://nas:3000#top", "http://", "http://exa mple"}) {
            try {
                ServerAddress.normalize(bad);
                fail("accepted " + bad);
            } catch (IllegalArgumentException expected) {
                assertFalse(expected.getMessage().isEmpty());
            }
        }
    }

    @Test
    public void onlyTheSavedOriginStaysInTheWindow() {
        String origin = "http://192.168.1.50:3000";
        assertTrue(ServerAddress.isSameOrigin(origin, "http://192.168.1.50:3000/"));
        assertTrue(ServerAddress.isSameOrigin(origin, "http://192.168.1.50:3000/some/deep/link?x=1"));
        assertFalse(ServerAddress.isSameOrigin(origin, "http://192.168.1.50:8000/"));
        assertFalse(ServerAddress.isSameOrigin(origin, "https://192.168.1.50:3000/"));
        assertFalse(ServerAddress.isSameOrigin(origin, "https://tunarr.com/"));
        assertFalse(ServerAddress.isSameOrigin(origin, "blob:http://192.168.1.50:3000/abc"));
        assertFalse(ServerAddress.isSameOrigin(origin, "not a url"));
        assertTrue(ServerAddress.isSameOrigin("https://lineup.example.com", "https://lineup.example.com:443/x"));
    }
}
