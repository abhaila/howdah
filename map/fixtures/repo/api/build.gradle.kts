plugins {
    kotlin("jvm")
}

dependencies {
    implementation(project(":shared:core"))
    implementation("org.http4k:http4k-core:6.0.0")
}
