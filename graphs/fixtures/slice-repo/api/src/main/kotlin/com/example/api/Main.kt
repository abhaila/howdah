package com.example.api

import org.http4k.server.Jetty
import org.http4k.server.asServer

fun main() {
    app().asServer(Jetty(9000)).start()
}
