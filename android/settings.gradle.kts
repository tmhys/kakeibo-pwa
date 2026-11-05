// このファイルは「プロジェクトに何が含まれるか」と「ライブラリをどこから取ってくるか」だけを決める。
pluginManagement {
    repositories {
        google()          // Android Gradle Plugin はここ
        mavenCentral()    // Kotlin はここ
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Kakeibo"
include(":app")
