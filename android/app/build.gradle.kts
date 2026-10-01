import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The repository root: the bot (src/) and the dashboard (dashboard/) are built into the app.
val repoRoot: File = rootProject.projectDir.parentFile

// Version: APP_VERSION / VERSION_CODE from CI, else <major.minor from package.json>-dev.
val baseVersion: String = Regex("\"version\"\\s*:\\s*\"(\\d+\\.\\d+)")
    .find(File(repoRoot, "package.json").readText())?.groupValues?.get(1) ?: "0.0"
val appVersion: String = System.getenv("APP_VERSION")?.takeIf { it.isNotBlank() } ?: "$baseVersion-dev"
val appVersionCode: Int = System.getenv("VERSION_CODE")?.toIntOrNull() ?: 1

// The engine (bot logic) and the dashboard are web code; both are built into generated assets.
val webAssets = layout.buildDirectory.dir("generated/webassets")
val npm = if (System.getProperty("os.name").lowercase().contains("windows")) "npm.cmd" else "npm"

val installEngineDeps by tasks.registering(Exec::class) {
    description = "Installs the engine's build tools (esbuild)."
    workingDir = file("../engine")
    commandLine(npm, "ci", "--no-audit", "--no-fund")
    inputs.file("../engine/package-lock.json")
    outputs.dir("../engine/node_modules")
}

val buildEngine by tasks.registering(Exec::class) {
    description = "Bundles the bot (src/) with its Android adapters into assets/engine."
    dependsOn(installEngineDeps)
    val out = webAssets.map { it.dir("engine") }
    workingDir = file("../engine")
    commandLine("node", "build.mjs")
    environment("ENGINE_OUT", out.get().asFile.absolutePath)
    environment("APP_VERSION", appVersion)
    inputs.dir("../engine/src")
    inputs.file("../engine/build.mjs")
    inputs.file("../engine/index.html")
    inputs.dir(File(repoRoot, "src"))
    inputs.property("version", appVersion)
    outputs.dir(out)
}

val installDashboardDeps by tasks.registering(Exec::class) {
    description = "Installs the dashboard's dependencies."
    workingDir = File(repoRoot, "dashboard")
    commandLine(npm, "ci", "--no-audit", "--no-fund")
    inputs.file(File(repoRoot, "dashboard/package-lock.json"))
    outputs.dir(File(repoRoot, "dashboard/node_modules"))
}

val buildDashboard by tasks.registering(Exec::class) {
    description = "Builds the dashboard into assets/ui; it talks to the engine over the app's bridge."
    dependsOn(installDashboardDeps)
    val out = webAssets.map { it.dir("ui") }
    workingDir = File(repoRoot, "dashboard")
    commandLine(npm, "exec", "--", "vite", "build", "--outDir", out.get().asFile.absolutePath, "--emptyOutDir")
    environment("VITE_APP_VERSION", appVersion)
    inputs.dir(File(repoRoot, "dashboard/src"))
    inputs.dir(File(repoRoot, "dashboard/public"))
    inputs.file(File(repoRoot, "dashboard/index.html"))
    inputs.property("version", appVersion)
    outputs.dir(out)
}

android {
    namespace = "com.autonaitra.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.autonaitra.app"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
    }

    signingConfigs {
        // A fixed debug key (committed on purpose, it guards nothing) so every build, local or CI,
        // can be installed over the previous one without losing the app's data.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        // Release builds use your own key when ANDROID_KEYSTORE_FILE is set, else the debug key.
        create("release") {
            val keystore = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
            if (keystore != null) {
                storeFile = file(keystore)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: System.getenv("ANDROID_KEYSTORE_PASSWORD")
            } else {
                storeFile = file("debug.keystore")
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
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

    buildFeatures {
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(webAssets)

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

tasks.named("preBuild") {
    dependsOn(buildEngine, buildDashboard)
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.webkit:webkit:1.17.1")
}
