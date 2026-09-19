package com.example.core;

import java.util.List;
import java.util.Map;

public class Greeter {
    private final String prefix;

    public Greeter(String prefix) {
        this.prefix = prefix;
    }

    public String greet(Object who) {
        String name = (String) who;
        return prefix + name;
    }

    public String greet(Map<String, List<Integer>> counts, int limit) {
        int total = counts.size();
        return format(total, limit);
    }

    private static String format(int total, int limit) {
        return String.valueOf(Math.min(total, limit));
    }

    public static class Nested {
        public void run(String... args) {
            Greeter g = new Greeter("hi ");
            g.greet((Object) args[0]);
        }
    }
}
