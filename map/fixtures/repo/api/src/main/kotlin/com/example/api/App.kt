package com.example.api

import com.example.core.Greeter
import org.http4k.core.HttpHandler
import org.http4k.core.Method
import org.http4k.core.Method.GET
import org.http4k.core.Request
import org.http4k.core.Response
import org.http4k.core.Status.Companion.OK
import org.http4k.routing.bind
import org.http4k.routing.routes

fun app(greeter: Greeter): HttpHandler = routes(
    "/health" bind GET to ::health,
    "/api" bind routes(
        "/users/{id}" bind GET to { req: Request -> getUser(req) },
        "/users" bind Method.POST to ::createUser,
        "/v1" bind routes(
            "/orders/{orderId:\\d+}" bind Method.DELETE to ::deleteOrder,
        ),
    ),
    adminRoutes(),
    "/shop" bind orderRoutes(),
)

fun adminRoutes(): HttpHandler = routes(
    crudPath("/admin") bind GET to ::health,
)

private fun crudPath(base: String): String = base + "/items"

private fun helper(x: Int): Int = x + 1

fun getUser(req: Request): Response {
    val id = req.path("id")
    val user = Renderer().render(User(id ?: "anon"))
    return Response(OK).body(user)
}

fun createUser(req: Request): Response = Response(OK).body(helper(1).toString())

fun deleteOrder(req: Request): Response {
    val n = req.path("orderId") as String?
    return Response(OK).body(n ?: "")
}
