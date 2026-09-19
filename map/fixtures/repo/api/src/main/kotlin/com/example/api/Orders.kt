package com.example.api

import org.http4k.core.HttpHandler
import org.http4k.core.Method.GET
import org.http4k.core.Request
import org.http4k.core.Response
import org.http4k.core.Status.Companion.OK
import org.http4k.routing.bind
import org.http4k.routing.routes

// Mounted from App.kt as `"/shop" bind orderRoutes()` — its prefix is only known across files.
fun orderRoutes(): HttpHandler = routes(
    "/orders" bind GET to ::listOrders,
)

fun listOrders(req: Request): Response = Response(OK)
