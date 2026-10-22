import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization) // GlanceSnapshot cache
}

// Brain base URL. Override with -Psidekiqq.brainUrl=https://... or in gradle.properties.
// At runtime the phone can also push a baseUrl over the Data Layer (/sidekiqq/token).
val brainUrl: String = (findProperty("sidekiqq.brainUrl") as String?) ?: "https://sidekiqq.vercel.app"

android {
    namespace = "com.sidekiqq.watch"
    compileSdk = 36

    defaultConfig {
        // The Wearable Data Layer only delivers between apps with the SAME applicationId and
        // signing key. This must equal :phone's applicationId (android/phone/build.gradle.kts).
        applicationId = "com.sidekiqq.app"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "BRAIN_URL", "\"$brainUrl\"")
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
        // Lets pure-logic tests touch android.* stubs without crashing (e.g. Log).
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":shared"))

    // Core / lifecycle
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.work.runtime.ktx)

    // Compose (BOM governs ui versions; compose-foundation comes transitively via wear compose-foundation)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)

    // Compose for Wear OS
    implementation(libs.androidx.wear.compose.material)
    implementation(libs.androidx.wear.compose.foundation)
    implementation(libs.androidx.wear.compose.navigation)

    // Wear platform pieces
    implementation(libs.androidx.wear.tiles)
    implementation(libs.androidx.wear.protolayout)
    implementation(libs.androidx.wear.watchface.complications.data.source.ktx)
    implementation(libs.androidx.wear.input)
    implementation(libs.play.services.wearable)

    // Coroutines bridges (Play Services Task.await(), Guava ListenableFuture for TileService)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)
    implementation(libs.kotlinx.coroutines.guava)

    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
}
