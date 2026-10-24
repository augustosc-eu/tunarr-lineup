// The Android app (D60): a full-screen window onto a Lineup server, like the
// desktop app but with the server running elsewhere. Release signing comes
// from the environment (CI secrets, see .github/workflows/android.yml);
// without it, release builds are signed with the debug key.
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
}

// Versioned like the rest of Lineup: 2026.10.15 → versionName "2026.10.15", versionCode 20261015.
val lineupVersion = (JsonSlurper().parse(rootDir.resolve("../package.json")) as Map<*, *>)["version"] as String
val (year, month, release) = lineupVersion.split(".").map { it.toInt() }

android {
    namespace = "io.github.augustosc_eu.tunarrlineup"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.augustosc_eu.tunarrlineup"
        minSdk = 24
        targetSdk = 36
        versionName = lineupVersion
        versionCode = year * 10000 + month * 100 + release
    }

    val keystore = System.getenv("ANDROID_KEYSTORE")
    signingConfigs {
        if (!keystore.isNullOrEmpty()) {
            create("release") {
                storeFile = file(keystore)
                storeType = "pkcs12"
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
