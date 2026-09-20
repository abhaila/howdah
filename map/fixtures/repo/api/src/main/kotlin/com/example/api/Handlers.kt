package com.example.api

import org.http4k.core.Request
import org.http4k.core.Response
import org.http4k.core.Status.Companion.OK

data class User(val id: String)
data class Order(val id: Long)

class Renderer {
    fun render(user: User): String = "user:" + user.id

    fun render(order: Order): String = "order:" + order.id

    fun <T> page(items: List<T>, limit: Int = 10): List<T> = items.take(limit)

    class Inner {
        fun describe(label: Map<String,   Int>): String {
            val size = label.size
            return "inner $size"
        }
    }

    companion object {
        fun create(): Renderer = Renderer()
    }
}

object Registry {
    fun lookup(key: String): Any? = null
}

fun String.slugify(): String = lowercase().replace(" ", "-")

fun health(req: Request): Response {
    val raw: Any = "ok"
    val text = raw as String
    val maybe = raw as? Int
    return Response(OK).body(text.slugify() + maybe)
}

private fun helper(x: Int): Int = x * 2
