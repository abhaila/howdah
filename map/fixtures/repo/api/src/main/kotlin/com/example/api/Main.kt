package com.example.api

import com.example.core.Greeter
import org.http4k.server.Jetty
import org.http4k.server.asServer

fun main() {
    app(Greeter("hi ")).asServer(Jetty(9000)).start()
}
