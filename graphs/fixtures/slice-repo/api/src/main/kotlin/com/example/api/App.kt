package com.example.api

import org.http4k.core.HttpHandler
import org.http4k.core.Method.GET
import org.http4k.core.Request
import org.http4k.core.Response
import org.http4k.core.Status.Companion.OK
import org.http4k.routing.bind
import org.http4k.routing.routes

fun app(): HttpHandler = routes(
    "/api" bind routes(
        "/users/{id}" bind GET to ::getUser,
    ),
)

fun getUser(req: Request): Response {
    val id = req.path("id") ?: "anon"
    return Response(OK).body("user:$id")
}
