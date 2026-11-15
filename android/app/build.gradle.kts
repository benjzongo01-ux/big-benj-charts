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
        versionCode = 3
        versionName = "1.2"
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
    // Réception des alertes en arrière-plan (Firebase Cloud Messaging).
    implementation(platform("com.google.firebase:firebase-bom:35.2.0"))
    implementation("com.google.firebase:firebase-messaging")
}

// Configuration Firebase : lue dans google-services.json (téléchargé depuis la console Firebase)
// et écrite en ressources Android, sans le module Gradle de Google.
val firebaseValues by tasks.registering {
    val json = file("google-services.json")
    val out = layout.buildDirectory.file("generated/firebase/res/values/firebase.xml")
    inputs.file(json).optional()
    outputs.file(out)
    doLast {
        require(json.exists()) { "Il manque android/app/google-services.json (console Firebase > Paramètres du projet > application Android)." }
        @Suppress("UNCHECKED_CAST")
        val root = groovy.json.JsonSlurper().parse(json) as Map<String, Any?>
        val info = root["project_info"] as Map<String, Any?>
        val clients = root["client"] as List<Map<String, Any?>>
        val client = clients.first {
            ((it["client_info"] as Map<String, Any?>)["android_client_info"] as Map<String, Any?>)["package_name"] == "com.bigbenj.charts"
        }
        val appId = (client["client_info"] as Map<String, Any?>)["mobilesdk_app_id"] as String
        val apiKey = ((client["api_key"] as List<Map<String, Any?>>).first())["current_key"] as String
        val f = out.get().asFile
        f.parentFile.mkdirs()
        f.writeText(
            """<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="google_app_id" translatable="false">$appId</string>
    <string name="google_api_key" translatable="false">$apiKey</string>
    <string name="gcm_defaultSenderId" translatable="false">${info["project_number"]}</string>
    <string name="project_id" translatable="false">${info["project_id"]}</string>
</resources>
"""
        )
    }
}
android.sourceSets.getByName("main").res.directories.add(layout.buildDirectory.dir("generated/firebase/res").get().asFile.path)
tasks.named("preBuild") { dependsOn(firebaseValues) }
