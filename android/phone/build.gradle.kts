plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// google-services.json is not committed (see README). Apply the plugin only when it is present
// so a fresh clone still builds; FCM is then simply disabled at runtime.
if (file("google-services.json").exists()) {
    apply(plugin = libs.plugins.google.services.get().pluginId)
}

// Jetpack XR Projected (androidx.xr.projected) is an alpha library. Everything that touches it is
// in src/xr; src/noxr holds a stub with the same API. If the alpha fails to resolve or compile,
// build with -Psidekiqq.xr=false: glasses then use the Bluetooth-headset bridge only.
val xrEnabled: Boolean = (findProperty("sidekiqq.xr") as String?)?.toBooleanStrictOrNull() ?: true

android {
    namespace = "com.sidekiqq.phone"

    sourceSets {
        getByName("main") {
            java.srcDir(if (xrEnabled) "src/xr/java" else "src/noxr/java")
        }
    }
    compileSdk = 36

    defaultConfig {
        // MUST match the watch app's applicationId, or the Wearable Data Layer will not deliver messages.
        applicationId = "com.sidekiqq.app"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    // jvmTarget instead of jvmToolchain: no extra JDK download needed (Android Studio's JBR 21 compiles fine).
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":shared"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.service)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.play.services.wearable)

    // Jetpack XR Projected (audio/display glasses). Alpha. All uses are isolated in src/xr
    // (ProjectedGlassesBridge, ProjectedSupport); see xrEnabled above.
    if (xrEnabled) {
        implementation(libs.androidx.xr.projected)
    }

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
