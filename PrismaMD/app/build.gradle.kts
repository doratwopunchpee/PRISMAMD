plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.prismamd"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.prismamd"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // Keep the bundled web assets (including .wasm) uncompressed so they stream fast.
    androidResources {
        noCompress += listOf("wasm", "js", "html")
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}
