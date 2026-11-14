import java.util.Properties

plugins {
    id("com.android.application")
}

// Clé de signature : gardée hors du dépôt Git (keystore.properties + fichier .jks).
val keystore = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.bigbenj.charts"
    compileSdk {
        version = release(36) { minorApiLevel = 1 }
    }

    defaultConfig {
        applicationId = "com.bigbenj.charts"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        create("release") {
            storeFile = rootProject.file(keystore.getProperty("storeFile", "bigbenj-release.jks"))
            storePassword = keystore.getProperty("storePassword", "")
            keyAlias = keystore.getProperty("keyAlias", "bigbenj")
            keyPassword = keystore.getProperty("keyPassword", "")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // Bibliothèque officielle de Google pour afficher un site vérifié en plein écran, avec ses notifications.
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
}
