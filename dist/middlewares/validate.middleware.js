export function validateBody(schema) {
    return (req, res, next) => {
        try {
            const parsed = schema.parse(req.body);
            req.body = parsed;
            next();
        }
        catch (error) {
            return res.status(400).json({
                success: false,
                errors: error.errors
            });
        }
    };
}
//# sourceMappingURL=validate.middleware.js.map